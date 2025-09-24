// Simplified Cover Letter Generator - Redis Worker

import 'dotenv/config'
import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import fetch from 'node-fetch'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import puppeteer from 'puppeteer'
import fs from 'fs'
import path from 'path'
import { extractTextFromPDF, cleanupFile } from './cvProcessor'
import { JobDatabase } from './supabase'

// Redis connection
const connection = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
})

const worker = new Worker('generate', async (job: Job) => {
  const { jobId, filePath, jobUrl, jobText } = job.data

  try {
    console.log(`Starting job ${jobId}`)
    
    // Update progress and step
    await job.updateProgress(10)
    await job.updateData({ step: 'Extracting CV text...' })

    // 1) Extract text from CV PDF
    const cvText = await extractTextFromPDF(filePath)
    
    if (!cvText || cvText.trim().length === 0) {
      throw new Error('No text could be extracted from the CV PDF')
    }

    // Update progress and step
    await job.updateProgress(20)
    await job.updateData({ step: 'Extracting job content...' })

    // 2) Extract job content (if URL provided)
    let jobContent = jobText
    if (jobUrl && !jobText) {
      console.log(`Fetching job content from URL: ${jobUrl}`)
      const resp = await fetch(jobUrl)
      const html = await resp.text()
      const dom = new JSDOM(html, { url: jobUrl })
      const article = new Readability(dom.window.document).parse()
      jobContent = article?.textContent || article?.content || ''
    }

    await job.updateProgress(30)
    await job.updateData({ step: 'Generating cover letter...' })

    // 3) Build prompt for LLM (Cover Letter Only)
    const prompt = `
You are an expert at creating tailored cover letters.

ORIGINAL CV CONTENT:
${cvText}

JOB OFFER:
${jobContent}

TASK:
Create a tailored cover letter for this specific job opportunity.

COVER LETTER REQUIREMENTS:
- Address the specific job requirements
- Highlight relevant experience from the CV
- Use a professional but personal tone
- Include specific examples that match the job
- End with a strong call to action
- Keep it around 300-400 words

IMPORTANT: You must respond with ONLY valid JSON. No additional text, explanations, or formatting.

OUTPUT FORMAT:
{
  "coverLetter": "Complete cover letter text"
}

RULES:
- Focus on relevance to the specific job
- Use keywords from the job description
- Quantify achievements where possible
- Keep content professional and compelling
- Return ONLY the JSON object, no other text
`

    await job.updateProgress(50)
    await job.updateData({ step: 'Calling AI...' })

    // 4) Call Ollama API
    console.log('Calling Ollama API...')
    const llmResp = await fetch(process.env.OLLAMA_URL || 'http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.2',
        prompt: prompt,
        stream: false
      })
    })
    const llmJson: any = await llmResp.json()
    const generatedText: string = llmJson.response || JSON.stringify(llmJson)

    await job.updateProgress(70)
    await job.updateData({ step: 'Parsing AI response...' })

    // 5) Parse AI response
    let parsed: any
    try {
      // Clean the response and try to extract JSON
      let cleanResponse = generatedText.trim()
      
      // Remove any text before the first {
      const firstBrace = cleanResponse.indexOf('{')
      if (firstBrace > 0) {
        cleanResponse = cleanResponse.substring(firstBrace)
      }
      
      // Remove any text after the last }
      const lastBrace = cleanResponse.lastIndexOf('}')
      if (lastBrace > 0 && lastBrace < cleanResponse.length - 1) {
        cleanResponse = cleanResponse.substring(0, lastBrace + 1)
      }
      
      parsed = JSON.parse(cleanResponse)
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError)
      console.log('Raw response:', generatedText.substring(0, 500))
      
      // Fallback: create a basic cover letter
      parsed = {
        coverLetter: `Dear Hiring Manager,\n\nI am writing to express my interest in the position. Based on my experience and skills, I believe I would be a great fit for this role.\n\n${generatedText.substring(0, 200)}...\n\nThank you for your consideration.\n\nBest regards`
      }
    }

    await job.updateProgress(85)
    await job.updateData({ step: 'Generating PDF...' })

    // 6) Generate Cover Letter PDF Only
    console.log('Generating Cover Letter PDF...')
    const browser = await puppeteer.launch({ 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 60000
    })
    const page = await browser.newPage()
    
    // Set longer timeout for page operations
    page.setDefaultTimeout(60000)
    
    // Simple HTML template for cover letter
    const coverHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
            .cover-letter { max-width: 800px; margin: 0 auto; }
            .header { margin-bottom: 30px; }
            .content { white-space: pre-wrap; }
        </style>
    </head>
    <body>
        <div class="cover-letter">
            <div class="header">
                <h2>Cover Letter</h2>
            </div>
            <div class="content">${parsed.coverLetter}</div>
        </div>
    </body>
    </html>
    `
    
    // Generate Cover Letter PDF
    await page.setContent(coverHtml, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const coverPdfPath = path.resolve(`out/cover-${jobId}.pdf`)
    await page.pdf({ path: coverPdfPath, format: 'A4', timeout: 60000 })

    await browser.close()

    await job.updateProgress(100)
    await job.updateData({ step: 'Completed!' })

    // Save cover letter data to Supabase
    const coverLetterData = {
      coverLetter: parsed.coverLetter,
      generatedAt: new Date().toISOString(),
      jobUrl: jobUrl,
      jobText: jobText
    }

    // Update Supabase with cover letter data and PDF URL
    await JobDatabase.updateJob(jobId, {
      cover_letter_json: coverLetterData,
      cover_letter_pdf_url: `/download/cover/${jobId}`,
      status: 'completed',
      progress: 100,
      current_step: 'Completed!',
      completed_at: new Date().toISOString()
    })

    // Clean up the uploaded file
    cleanupFile(filePath)

    console.log(`Job ${jobId} completed successfully`)
    return { 
      cover: coverPdfPath,
      jobId,
      status: 'completed',
      coverLetterData: coverLetterData
    }

  } catch (error) {
    console.error(`Job ${jobId} processing error:`, error)
    // Clean up the uploaded file even on error
    if (filePath) {
      cleanupFile(filePath)
    }
    throw error
  }
}, { 
  connection,
  concurrency: 2, // Process up to 2 jobs concurrently
})

worker.on('ready', () => {
  console.log('🚀 Worker is ready and waiting for jobs...')
})

worker.on('failed', (job, err) => {
  console.error(`Worker: Job ${job?.id} failed with error: ${err.message}`);
});

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed successfully`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down worker...')
  await worker.close()
  process.exit(0)
})
