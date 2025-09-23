// pipeline (fetch → extract → LLM → PDF)

import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import fetch from 'node-fetch'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import Handlebars from 'handlebars'
import puppeteer from 'puppeteer'
import fs from 'fs'
import path from 'path'

const connection = new IORedis()
const worker = new Worker('generate', async (job: Job) => {
  const { url, text, profile } = job.data

  // 1) content extraction (if url)
  let jobText = text
  if (url && !text) {
    const resp = await fetch(url)
    const html = await resp.text()
    const dom = new JSDOM(html, { url })
    const article = new Readability(dom.window.document).parse()
    jobText = article?.textContent || article?.content || ''
  }

  // 2) build prompt for LLM
  const prompt = `You are an assistant that writes tailored CV bullet points and a cover letter.
Job post:
${jobText}

Applicant base profile:
${JSON.stringify(profile)}

Produce:
1) a short tailored cover letter (~250 words)
2) a list of updated resume bullet points (JSON array)
Return JSON only.
`

  // 3) call Ollama API
  const llmResp = await fetch(process.env.OLLAMA_URL || 'http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'llama3.2',
      prompt,
      stream: false
    })
  })
  const llmJson: any = await llmResp.json()
  const generatedText: string = llmJson.response || JSON.stringify(llmJson)

  // (parse generatedText expecting JSON and extract coverLetter & bullets)
  let parsed: { coverLetter?: string; bullets?: any[] }
  try {
    parsed = JSON.parse(generatedText)
  } catch {
    parsed = { coverLetter: generatedText }
  }

  // 4) Render templates
  const coverTemplate = Handlebars.compile(fs.readFileSync(path.resolve('templates/cover.hbs'), 'utf8'))
  const cvTemplate = Handlebars.compile(fs.readFileSync(path.resolve('templates/cv.hbs'), 'utf8'))

  const coverHtml = coverTemplate({ coverLetter: parsed.coverLetter, profile })
  const cvHtml = cvTemplate({ profile, bullets: parsed.bullets || [] })

  // 5) PDF via Puppeteer
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] })
  const page = await browser.newPage()
  await page.setContent(coverHtml, { waitUntil: 'networkidle0' })
  const coverPdfPath = path.resolve(`out/cover-${job.id}.pdf`)
  await page.pdf({ path: coverPdfPath, format: 'A4' })

  await page.setContent(cvHtml, { waitUntil: 'networkidle0' })
  const cvPdfPath = path.resolve(`out/cv-${job.id}.pdf`)
  await page.pdf({ path: cvPdfPath, format: 'A4' })

  await browser.close()

  return { cover: coverPdfPath, cv: cvPdfPath }
}, { connection })
