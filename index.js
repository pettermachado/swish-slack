'use strict'

const crypto = require('crypto')
const fetch = require('node-fetch')
const config = require('./config.json')

const messageFormat = /^\s*(\+?(\s?[0-9]+)*)\s+([1-9][0-9]*)\s+(.*)$/
const pathFormat = /^\/?(.+)\.png$/

/*
 * encryptSwishReq - serializes and encrypts a swish request
 */
function encryptSwishReq (swishReq) {
  const {payee, amount, message} = swishReq
  const cipher = crypto.createCipher('aes-256-ctr', config.CIPHER)
  let crypted = cipher.update(JSON.stringify([payee, amount, message]), 'utf8', 'hex')
  crypted += cipher.final('hex')
  return crypted
}

/*
 * decryptSwishReq - deserializes and decrypts a swish request
 */
function decryptSwishReq (text) {
  const decipher = crypto.createDecipher('aes-256-ctr', config.CIPHER)
  let dec = decipher.update(text,'hex','utf8')
  dec += decipher.final('utf8')
  const [payee, amount, message] = JSON.parse(dec)
  return {payee, amount, message}
}

/*
 * parseInput - parse and validate the text the user typed after /swish
 */
function parseInput (text) {
  const pts = messageFormat.exec(text)
  if (!pts || pts.length !== 5) {
    throw new Error('Invalid format')
  }
  const payee = pts[1]
  const amount = Number(pts[3])
  const message = pts[4].substring(0, 50) // Swish allows max 50 characters as message

  const swishReq = {
    payee,
    amount,
    message
  }
  return swishReq
}

/*
 * editable - returns an editable field definition
 */
function editable (value, editable) {
  return { value, editable }
}

/*
 * formatSlackMessage - formats a slack message for a request
 */
function formatSlackMessage (swishReq, imageURL) {
  return {
    response_type: 'in_channel',
    attachments: [
      {
        fallback: `Swish ${swishReq.amount} kr to ${swishReq.payee}`,
        text: `Swish ${swishReq.amount} kr to ${swishReq.payee}`,
        image_url: imageURL,
      }
    ]
  }
}

/*
 * verifyWebhook - verify the call came from slack
 */
function verifyWebhook (body) {
  if (!body || body.token !== config.SLACK_TOKEN) {
    const error = new Error('Invalid credentials')
    error.code = 401
    throw error
  }
}

/*
 * handleErr - returns a function to be used as a catch(), setting http
 * status code and sending the error back to the caller.
 */
function handleErr (res) {
  return function (err) {
    console.error(err)
    res.status(err.code || 500).send(err)
    return Promise.reject(err)
  }
}

/*
 * imageURL - decode a URL from swishMe and proxy the image from swish
 */
exports.imageURL = (req, res) => {
  return Promise.resolve()
    .then(() => {
      const pts = pathFormat.exec(req.path)
      if (!pts || pts.length !== 2) {
        const error = new Error('Invalid URL format')
        error.code = 400
        throw error
      }

      let swishReq
      try {
        swishReq = decryptSwishReq(pts[1])
      } catch (e) {
        const error = new Error('Failed to decipher: ' + e)
        error.code = 400
        throw error
      }

      const swishOpts = { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'png',
          size: 512,
          message: editable(swishReq.message, true),
          amount: editable(swishReq.amount, false),
          payee: editable(swishReq.payee, false)
        }),
      }

      return fetch(config.SWISH_QR_URL, swishOpts)
        .then(swishRes => {
          if (swishRes.status !== 200) {
            throw new Error('Unexpected HTTP status ' + swishRes.status)
          }
          res.writeHead(200, {
            'Content-Type': swishRes.headers.get('content-type'),
            'Content-Length': swishRes.headers.get('content-length'),
          })
          swishRes.body.pipe(res)
        })
    })
    .catch(handleErr(res))
}

/*
 * swishMe - parses user input and return a slack message
 */
exports.swishMe = (req, res) => {
  return Promise.resolve()
    .then(() => {
      if (req.method !== 'POST') {
        const error = new Error('Only POST requests are accepted, got ' + req.method)
        error.code = 405
        throw error
      }

      // Verify that this request came from Slack
      verifyWebhook(req.body)

      let swishReq
      try {
        swishReq = parseInput(req.body.text)
      } catch (err) {
        console.error(err)
        res.json({
          response_type: 'ephemeral',
          text: 'Sorry, I didn\'t get that :confused: Please use \`/slack number amount message\`'
        })
        return
      }

      const encr = encryptSwishReq(swishReq)
      const imageURL = config.IMAGE_FUNCTION + '/' + encr + '.png'

      // Send a quick response to avoid timeout.
      const message = formatSlackMessage(swishReq, imageURL)
      res.json(message)
    })
    .catch(handleErr(res))
}
