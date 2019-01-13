// @ts-check
//
const restify = require('restify')
const os = require('os')
const request = require('request-promise-native')
const uuid = require('uuid')

const UPSTREAM = (process.env.UPSTREAM || '').split(',').map(k => k.trim()).filter(k => k.length > 0).map(k => `http://${k}/`)
if (UPSTREAM.length <= 0) {
  console.error('no environment variable for UPSTREAM')
  process.exit(1)
}
console.log(UPSTREAM)

const NAME = process.env.NAME || 'unnamed'
const server = restify.createServer({
  name: NAME,
  // as a demo, let's format responses
  //
  formatters: {
    'application/json': (req, res, body) => {
      return JSON.stringify(body, null, 2)
    }
  }
})

const networks = () => {
  const info = os.networkInterfaces()
  let list = []
  Object.keys(info).forEach(name => {
    const o = info[name]
    o.forEach(i => {
      if (i.family === 'IPv4')
        list.push(`${name}/${i.address}`)
    })
  })
  return list
}

function healthy() {
  return { healthy: true }
}

function ready() {
  const result = Object.assign({}, healthy(), { ready: false })

  // skip out if we are not healthy
  //
  if (!result.healthy)
    return result

  // now decide if we are ready
  //
  result.ready = true

  return result
}

const requestBlock = (req, url) => {
  const COPY = [
    'x-request-id',
    'x-b3-traceid',
    'x-b3-spanid',
    'x-b3-parentspanid',
    'x-b3-sampled',
    'x-b3-flags',
    'x-ot-span-context'
  ]
  const result = {
    url: url,
    method: 'get',
    json: true,
    headers: {}
  }
  COPY.forEach(key => {
    const value = req.header(key, '')
    if (value)
      result.headers[key] = value
  })
  if (!req.header('x-request-id', null))
    result.headers['x-request-id'] = uuid.v4()

  return result
}

server.get('/health', (req, res, next) => {
  const body = healthy()
  const status = body.healthy ? 200 : 503
  res.json(status, body)
  return next()
})

server.get('/ready', (req, res, next) => {
  const body = ready()
  const status = body.ready ? 200 : 503
  res.json(status, body)
  return next()
})

const callUpstream = (req, url) => {
  const block = requestBlock(req, url)
  const result = { url, ok: true, time: 0, message: '' }
  const START = Date.now()
  return request(block)
    .then(() => {
      return result
    })
    .catch(err => {
      result.ok = false
      result.message = err.message
      return result
    })
    .then(result => {
      const FINISH = Date.now()
      result.time = FINISH - START
      return result
    })
}

const callAllUpstream = req => {
  const list = UPSTREAM.map(d => callUpstream(req, d))
  return Promise.all(list)
}

const dumpCaller = req => {
  console.log(`${req.connection.remoteAddress} => ${req.method} ${req.url}`)
  Object.keys(req.headers).forEach(h => {
    console.log(`  ${h} => ${req.headers[h]}`)
  })
  return req
}

server.get('/', (req, res, next) => {
  const now = (new Date()).toISOString()
  const data = {
    ts: `${now}`,
    name: `${NAME}`,
    host: os.hostname(),
    net: networks(),
    headers: req.headers
  }

  return Promise.resolve(req)
    .then(dumpCaller)
    .then(callAllUpstream)
    .then(results => {
      data.results = results
      return data
    })
    .catch(err => {
      console.log(err.message)
      const body = {
        error: err.message
      }
      return body
    })
    .then(body => {
      res.json(200, body)
      return next()
    })
})

server.listen(process.env.PORT || 80, '0.0.0.0', (err) => {
  console.log(`listening on ${server.name} at ${server.url}`)
})
