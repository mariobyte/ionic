var _ = require('lodash');
var buildConfig = require('./scripts/build/config');
var fs = require('fs');
var gulp = require('gulp');
var karma = require('karma').server;
var path = require('path');
var VinylFile = require('vinyl');
var argv = require('yargs').argv;
var cached = require('gulp-cached');
var concat = require('gulp-concat');
var del = require('del');
var gulpif = require('gulp-if');
var rename = require('gulp-rename');
var sass = require('gulp-sass');
var autoprefixer = require('gulp-autoprefixer');
var through2 = require('through2');
var runSequence = require('run-sequence');
var watch = require('gulp-watch');
var exec = require('child_process').exec;
var babel = require('gulp-babel');
var tsc = require('gulp-typescript');
var lazypipe = require('lazypipe');
var cache = require('gulp-cached');
var connect = require('gulp-connect');
var Dgeni = require('dgeni');
var insert = require('gulp-insert');
var minimist = require('minimist');

function getBabelOptions(moduleName, moduleType) {
  return {
    optional: ['es7.decorators'],
    modules: moduleType || "system",
    moduleIds: true,
    getModuleId: function(name) {
      return moduleName + '/' + name.split('/test').join('');
    }
  }
}

var tscOptions = {
  target: 'ES6',
  allowNonTsExtensions: true,
  isolatedModules: true,
  emitDecoratorMetadata: true,
  experimentalDecorators: true,
  noEmitOnError: false,  // ignore errors
  rootDir: '.'
}
var tscReporter = {
    error: function (error) {
        console.error(error.message);
    }
};

var flagConfig = {
  string: 'port',
  alias: {'p': 'port'},
  default: { port: 8000 }
};

var flags = minimist(process.argv.slice(2), flagConfig);

gulp.task('build', function(done) {
  runSequence(
    'bundle',
    'e2e',
    'sass',
    'fonts',
    done
  );
})

gulp.task('clean.build', function(done) {
  runSequence('clean', 'build', done);
})

gulp.task('watch', function(done) {
  runSequence(
    'build',
    'serve',
    function() {
      watch([
          'ionic/**/*.js',
          'ionic/**/*.ts',
          '!ionic/components/*/test/**/*',
          '!ionic/util/test/*'
        ],
        function() {
          runSequence('bundle', 'e2e');
        }
      );

      watch('ionic/components/*/test/**/*', function() {
        gulp.start('e2e');
      });

      watch('ionic/**/*.scss', function() {
        gulp.start('sass');
      });

      done();
    }
  );
});

gulp.task('serve', function() {
  connect.server({
    root: 'dist',
    port: flags.port,
    livereload: false
  });
});

gulp.task('clean', function(done) {
  del(['dist/'], done);
});

function transpile(moduleType) {
  var stream = gulp.src([
      'ionic/**/*.ts',
      'ionic/**/*.js',
      '!ionic/components/*/test/**/*',
      '!ionic/util/hairline.js',
      '!ionic/util/test/*'
    ])
   .pipe(cache('transpile', { optimizeMemory: true }))
   .pipe(tsc(tscOptions, null, tscReporter))
   .on('error', function(error) {
     stream.emit('end');
   })
   .pipe(gulp.dest('dist/js/es6/ionic'))
   .pipe(babel(getBabelOptions('ionic', moduleType)))
   .on('error', function (err) {
     console.log("ERROR: " + err.message);
     this.emit('end');
   })
   .pipe(gulp.dest('dist/js/es5/' + moduleType + '/ionic'))

  return stream;
}

gulp.task('transpile.system', function() { return transpile("system"); });
gulp.task('transpile.common', function() { return transpile("common"); });
gulp.task('transpile', ['transpile.system']);

gulp.task('bundle.ionic', ['transpile'], function() {
  return gulp.src([
      'dist/js/es5/system/ionic/**/*.js',
      'ionic/util/hairline.js'
    ])
    .pipe(concat('ionic.js'))
    .pipe(insert.append('System.config({ "paths": { "ionic/*": "ionic/*" } });'))
    .pipe(gulp.dest('dist/js/'));
    //TODO minify + sourcemaps
});

gulp.task('bundle', ['bundle.ionic'], function() {
  var nm = "node_modules";
  return gulp.src(buildConfig.scripts)
    .pipe(concat('ionic.bundle.dev.js'))
    .pipe(gulp.dest('dist/js'));;
})

gulp.task('tests', function() {
  return gulp.src('ionic/components/*/test/*/**/*.spec.ts')
    .pipe(tsc(tscOptions, null, tscReporter))
    .pipe(babel(getBabelOptions('dist/tests')))
    .pipe(rename(function(file) {
      file.dirname = file.dirname.replace(path.sep + 'test' + path.sep, path.sep)
    }))
    .pipe(gulp.dest('dist/tests'))
})

gulp.task('e2e', function() {
  var buildTest = lazypipe()
             //.pipe(traceur, traceurOptions)
             .pipe(tsc, tscOptions, null, tscReporter)
             .pipe(babel, getBabelOptions('e2e'))

  var buildE2ETest = lazypipe()
             //.pipe(traceur, traceurOptions)
             .pipe(tsc, tscOptions, null, tscReporter)
             .pipe(babel)

  var indexTemplate = _.template(
   fs.readFileSync('scripts/e2e/e2e.template.html')
  )({
   buildConfig: buildConfig

  })
  var testTemplate = _.template( fs.readFileSync('scripts/e2e/e2e.template.js') )

  var platforms = [
    'android',
    'ios',
    //'core'
  ];

  // Get each test folder with gulp.src
  return gulp.src(['ionic/components/*/test/*/**/*', '!ionic/components/*/test/*/**/*.spec.ts'])
    .pipe(cache('e2e', { optimizeMemory: true }))
    .pipe(gulpif(/e2e.ts$/, buildE2ETest()))
    .pipe(gulpif(/.ts$/, buildTest()))
    .on('error', function (err) {
      console.log("ERROR: " + err.message);
      this.emit('end');
    })
    .pipe(gulpif(/index.js$/, createIndexHTML())) //TSC changes .ts to .js
    .pipe(rename(function(file) {
      file.dirname = file.dirname.replace(path.sep + 'test' + path.sep, path.sep)
    }))
    .pipe(gulpif(/e2e.js$/, createPlatformTests()))
    .pipe(gulp.dest('dist/e2e/'))

  function createIndexHTML() {
    return through2.obj(function(file, enc, next) {
      var self = this;

      var module = path.dirname(file.path)
                      .replace(__dirname, '')
                      .replace('/ionic/components/', 'e2e/')
                      .replace('/test/', '/') +
                      '/index';

      var indexContents = indexTemplate.replace('{{MODULE}}', module);

      self.push(new VinylFile({
        base: file.base,
        contents: new Buffer(indexContents),
        path: path.join(path.dirname(file.path), 'index.html'),
      }));
      next(null, file);
    });
  }

  function createPlatformTests(file) {
    return through2.obj(function(file, enc, next) {
      var self = this
      var relativePath = path.dirname(file.path.replace(/^.*?ionic(\/|\\)components(\/|\\)/, ''))
      var contents = file.contents.toString()
      platforms.forEach(function(platform) {
        var platformContents = testTemplate({
          contents: contents,
          buildConfig: buildConfig,
          relativePath: relativePath,
          platform: platform
        })
        self.push(new VinylFile({
          base: file.base,
          contents: new Buffer(platformContents),
          path: file.path.replace(/e2e.js$/, platform + '.e2e.js')
        }))
      })
      next()
    })
  }
});

gulp.task('sass', function() {
  return gulp.src('ionic/ionic.scss')
    .pipe(sass({
      onError: function(err) {
        console.log(err)
      }
    }))
    .pipe(autoprefixer(buildConfig.autoprefixer))
    .pipe(gulp.dest('dist/css/'));
});

gulp.task('fonts', function() {
  return gulp.src('ionic/components/icon/fonts/**/*')
    .pipe(gulp.dest('dist/fonts'));
});

require('./scripts/snapshot/snapshot.task')(gulp, argv, buildConfig);

gulp.task('karma', function() {
  return karma.start({ configFile: __dirname + '/scripts/karma/karma.conf.js' })
  //return karma.start({ configFile: __dirname + '/karma.conf.js' })
});

gulp.task('karma-watch', function() {
  return karma.start({ configFile: __dirname + '/scripts/karma/karma-watch.conf.js' })
});

gulp.task('docs', function() {
  try {
    var dgeni = new Dgeni([require('./scripts/docs/dgeni-config')]);
    return dgeni.generate();
  } catch (err) {
    console.log(err.stack);
  }
})
