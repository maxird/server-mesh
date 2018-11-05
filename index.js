'use strict'

const restify = require('restify')
const os = require('os')
const request = require('request-promise-native')
const uuid = require('uuid')

const DOWNSTREAM = (process.env.DOWNSTREAM || '').split(',').map(k => k.trim()).filter(k => k.length > 0).map(k => `http://${k}/`)
if (DOWNSTREAM.length <= 0) {
  console.error('no environment variable for DOWNSTREAM')
  process.exit(1)
}
console.log(DOWNSTREAM)

const server = restify.createServer({})

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
  const body = JSON.stringify({ ok: true }) + '\n'

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  })
  res.write(body)
  res.end()
  return next()
})

const callDownstream = (req, url) => {
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

const callAllDownstream = req => {
  const list = DOWNSTREAM.map(d => callDownstream(req, d))
  return Promise.all(list)
}

server.get('/', (req, res, next) => {
  const now = (new Date()).toISOString()
  const data = {
    ts: `${now}`,
    name: os.hostname(),
    net: networks(),
    headers: req.headers
  }

  return Promise.resolve(req)
    .then(callAllDownstream)
    .then(results => {
      data.results = results
      return data
    })
    .then(data => {
      const body = JSON.stringify(data, null, 2) + '\n'
      return body
    })
    .then(body => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      })

      res.write(body)
      res.end()
      return next()
    })
})

server.listen(process.env.PORT || 3000, '0.0.0.0', (err) => {
  console.log(`listening on ${server.name} at ${server.url}`)
})
