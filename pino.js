'use strict'

var stringifySafe = require('fast-safe-stringify')
var EventEmitter = require('events').EventEmitter
var fs = require('fs')
var pump = require('pump')
var flatstr = require('flatstr')
var pretty = require('./pretty')
var events = require('./lib/events')
var levels = require('./lib/levels')
var tools = require('./lib/tools')
var serializers = require('./lib/serializers')
var time = require('./lib/time')

var LOG_VERSION = 1

var defaultOptions = {
  safe: true,
  name: undefined,
  serializers: {},
  timestamp: time.epochTime,
  slowtime: false,
  extreme: false,
  level: 'info',
  levelVal: undefined,
  prettyPrint: false,
  onTerminated: function (eventName, err) {
    if (err) return process.exit(1)
    process.exit(0)
  },
  enabled: true,
  messageKey: 'msg'
}

var pinoPrototype = Object.create(EventEmitter.prototype, {
  silent: {
    value: tools.noop,
    enumerable: true
  },
  stream: {
    value: process.stdout,
    writable: true
  },
  pino: {
    value: require('./package.json').version,
    enumerable: true
  }
})

var levelMethods = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']
levelMethods.forEach(function (m) {
  Object.defineProperty(pinoPrototype, m, {
    value: tools.genLog(levels.levels[m]),
    enumerable: true,
    writable: true
  })
})

function getLevelVal () {
  return this._levelVal
}
function setLevelVal (num) {
  if (typeof num === 'string') { return this._setLevel(num) }

  if (this.emit) {
    this.emit('level-change', this.levels.labels[num], num, this.levels.labels[this._levelVal], this._levelVal)
  }

  this._levelVal = num

  for (var key in this.levels.values) {
    if (num > this.levels.values[key]) {
      this[key] = tools.noop
      continue
    }
    this[key] = levels.isStandardLevel(key) ? pinoPrototype[key] : tools.genLog(this.levels.values[key])
  }
}
Object.defineProperty(pinoPrototype, 'levelVal', {
  get: getLevelVal,
  set: setLevelVal
})

function _setLevel (level) {
  if (typeof level === 'number') {
    if (!isFinite(level)) {
      throw Error('unknown level ' + level)
    }
    level = this.levels.labels[level]
  }

  if (!this.levels.values[level]) {
    throw Error('unknown level ' + level)
  }
  this.levelVal = this.levels.values[level]
}
Object.defineProperty(pinoPrototype, '_setLevel', {
  value: _setLevel
})

Object.defineProperty(pinoPrototype, '_getLevel', {
  value: function _getLevel (level) {
    return this.levels.labels[this.levelVal]
  }
})

Object.defineProperty(pinoPrototype, 'level', {
  get: pinoPrototype._getLevel,
  set: pinoPrototype._setLevel
})

Object.defineProperty(pinoPrototype, '_lscache', {
  value: tools.copy({}, levels.lscache)
})

Object.defineProperty(
  pinoPrototype,
  'LOG_VERSION',
  {value: LOG_VERSION}
)

function asJson (obj, msg, num) {
  if (!msg && obj instanceof Error) {
    msg = obj.message
  }
  var data = this._baseLog + this._lscache[num] + this.time()
  // to catch both null and undefined
  /* eslint-disable eqeqeq */
  if (msg != undefined) {
    data += this.messageKeyString + JSON.stringify('' + msg)
  }
  // we need the child bindings added to the output first so that logged
  // objects can take precedence when JSON.parse-ing the resulting log line
  data = data + this.chindings
  var value
  if (obj) {
    if (obj.stack) {
      data += ',"type":"Error","stack":' + this.stringify(obj.stack)
    }
    for (var key in obj) {
      value = obj[key]
      if ((!obj.hasOwnProperty || obj.hasOwnProperty(key)) && value !== undefined) {
        value = this.stringify(this.serializers[key] ? this.serializers[key](value) : value)
        if (value !== undefined) {
          data += ',"' + key + '":' + value
        }
      }
    }
  }
  return data + this.end
}
Object.defineProperty(pinoPrototype, 'asJson', {
  enumerable: true,
  value: asJson
})

function child (bindings) {
  if (!bindings) {
    throw Error('missing bindings for child Pino')
  }

  var data = ','
  var value
  var key
  for (key in bindings) {
    value = bindings[key]
    if (key !== 'level' && key !== 'serializers' && bindings.hasOwnProperty(key) && value !== undefined) {
      value = this.serializers[key] ? this.serializers[key](value) : value
      data += '"' + key + '":' + this.stringify(value) + ','
    }
  }
  data = this.chindings + data.substr(0, data.length - 1)

  var opts = {
    level: bindings.level || this.level,
    levelVal: levels.isStandardLevelVal(this.levelVal) ? undefined : this.levelVal,
    serializers: bindings.hasOwnProperty('serializers') ? Object.assign({}, this.serializers, bindings.serializers) : this.serializers,
    stringify: this.stringify,
    end: this.end,
    name: this.name,
    timestamp: this.timestamp,
    slowtime: this.slowtime,
    chindings: data,
    cache: this.cache,
    formatOpts: this.formatOpts,
    messageKey: this.messageKey,
    messageKeyString: this.messageKeyString
  }

  var _child = Object.create(this)
  _child.stream = this.stream
  tools.applyOptions.call(_child, opts)
  return _child
}
Object.defineProperty(pinoPrototype, 'child', {
  enumerable: true,
  value: child
})

function pinoWrite (obj, msg, num) {
  var s = this.asJson(obj, msg, num)
  if (!this.cache) {
    this.stream.write(flatstr(s))
    return
  }

  this.cache.buf += s
  if (this.cache.buf.length > this.cache.size) {
    this.stream.write(flatstr(this.cache.buf))
    this.cache.buf = ''
  }
}
Object.defineProperty(pinoPrototype, 'write', {
  value: pinoWrite
})

function flush () {
  if (!this.cache) {
    return
  }

  this.stream.write(flatstr(this.cache.buf))
  this.cache.buf = ''
}
Object.defineProperty(pinoPrototype, 'flush', {
  enumerable: true,
  value: flush
})

function addLevel (name, lvl) {
  if (this.levels.values.hasOwnProperty(name)) return false
  if (this.levels.labels.hasOwnProperty(lvl)) return false
  this.levels.values[name] = lvl
  this.levels.labels[lvl] = name
  this._lscache[lvl] = flatstr('"level":' + Number(lvl))
  this[name] = tools.genLog(lvl)
  return true
}
Object.defineProperty(pinoPrototype, 'addLevel', {
  enumerable: true,
  value: addLevel
})

function pino (opts, stream) {
  var iopts = opts
  var istream = stream
  if (iopts && (iopts.writable || iopts._writableState)) {
    istream = iopts
    iopts = defaultOptions
  }
  iopts = Object.assign({}, defaultOptions, iopts)
  if (iopts.extreme && iopts.prettyPrint) throw Error('cannot enable pretty print in extreme mode')
  istream = istream || process.stdout
  if (iopts.prettyPrint) {
    var prettyOpts = Object.assign({ messageKey: iopts.messageKey }, iopts.prettyPrint)
    var pstream = pretty(prettyOpts)
    var origStream = istream
    pump(pstream, origStream, function (err) {
      if (err) instance.emit('error', err)
    })
    istream = pstream
  }

  // internal options
  iopts.stringify = iopts.safe ? stringifySafe : JSON.stringify
  iopts.formatOpts = {lowres: true}
  iopts.messageKeyString = `,"${iopts.messageKey}":`
  iopts.end = ',"v":' + LOG_VERSION + '}\n'
  iopts.cache = !iopts.extreme ? null : {
    size: 4096,
    buf: ''
  }
  iopts.chindings = ''

  if (iopts.enabled === false) {
    iopts.level = 'silent'
  }

  var instance = Object.create(pinoPrototype)
  instance.stream = istream
  tools.defineLevelsProperty(instance)
  tools.applyOptions.call(instance, iopts)
  if (iopts.cache) setTimeout(waitForFDSettle, 100)

  var settleTries = 0
  function waitForFDSettle () {
    var isBlockable = tools.streamIsBlockable(istream)
    if (isBlockable === false && settleTries > 10) {
      return instance.emit('error', Error('stream must have a file descriptor in extreme mode'))
    } else if (isBlockable === true) {
      return events(instance, extremeModeExitHandler)
    }
    settleTries += 1
    setTimeout(waitForFDSettle, 100)
  }

  function extremeModeExitHandler () {
    var buf = iopts.cache.buf
    if (buf) {
      // We need to block the process exit long enough to flush the buffer
      // to the destination stream. We do that by forcing a synchronous
      // write directly to the stream's file descriptor.
      var fd = (istream.fd) ? istream.fd : istream._handle.fd
      fs.writeSync(fd, buf)
    }
  }

  return instance
}

tools.defineLevelsProperty(pino)

module.exports = pino
module.exports.stdSerializers = {
  req: serializers.asReqValue,
  res: serializers.asResValue,
  err: serializers.asErrValue
}
module.exports.stdTimeFunctions = Object.assign({}, time)
module.exports.pretty = pretty
Object.defineProperty(
  module.exports,
  'LOG_VERSION',
  {value: LOG_VERSION, enumerable: true}
)
