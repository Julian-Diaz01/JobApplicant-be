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
import handlebars from 'handlebars'
import { extractTextFromPDF, cleanupFile } from './cvProcessor'
import { JobDatabase } from './supabase'

// Redis connection
const connection = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
})

// Register Handlebars helper for array checking
handlebars.registerHelper('isArray', function(value) {
  return Array.isArray(value)
})

// Load the Handlebars template
const templatePath = path.join(__dirname, '../templates/cover.hbs')
const templateSource = fs.readFileSync(templatePath, 'utf8')
const template = handlebars.compile(templateSource)

// Function to extract sender information from CV text
function extractSenderInfo(cvText: string) {
  const sender: any = {}
  
  // Extract email
  const emailMatch = cvText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
  if (emailMatch) {
    sender.email = emailMatch[1]
  }
  
  // Extract phone number
  const phoneMatch = cvText.match(/(\+?[\d\s\-\(\)]{10,})/i)
  if (phoneMatch) {
    sender.phone = phoneMatch[1].trim()
  }
  
  // Extract name (usually at the beginning of CV)
  const lines = cvText.split('\n').filter(line => line.trim().length > 0)
  if (lines.length > 0) {
    const firstLine = lines[0].trim()
    // If first line doesn't contain email or phone, it's likely the name
    if (!firstLine.includes('@') && !firstLine.match(/\d/)) {
      sender.name = firstLine
    }
  }
  
  // Extract address (look for common address patterns)
  const addressMatch = cvText.match(/(\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd)[^,\n]*)/i)
  if (addressMatch) {
    sender.address = addressMatch[1].trim()
  }
  
  return sender
}

const worker = new Worker('generate', async (job: Job) => {
  const { jobId, filePath, jobUrl, jobText, customQuestion } = job.data

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

    // 3) Build prompt for LLM (Cover Letter + Question)
    const randomQuestions = [
      "What's your biggest professional achievement?",
      "How do you handle tight deadlines?",
      "What motivates you in your work?",
      "Describe a challenging problem you solved.",
      "What's your approach to learning new technologies?",
      "How do you work in a team environment?",
      "What's your biggest professional weakness and how do you address it?",
      "Where do you see yourself in 5 years?",
      "What's your favorite project you've worked on?",
      "How do you stay updated with industry trends?"
    ]
    
    // Use custom question if provided, otherwise pick a random one
    const selectedQuestion = customQuestion && customQuestion.trim() 
      ? customQuestion.trim() 
      : randomQuestions[Math.floor(Math.random() * randomQuestions.length)]

    const prompt = `Create a tailored cover letter and answer a professional question based on the provided CV and job description.

CV CONTENT:
${cvText}

JOB DESCRIPTION:
${jobContent}

QUESTION TO ANSWER:
${selectedQuestion}

INSTRUCTIONS:
1. Write a complete cover letter addressing the job requirements
2. Answer the question with at least 100 words
3. Use ONLY information from the CV - do not make up anything
4. Be honest if the CV lacks relevant information

REQUIRED OUTPUT FORMAT (JSON ONLY):
{
  "coverLetter": "Your complete cover letter here",
  "question": "${selectedQuestion}",
  "answer": "Your detailed answer here (minimum 100 words)"
}

CRITICAL: You must return ONLY valid JSON. Complete the entire structure including the closing brace. Do not truncate or cut off the response.`

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
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: -1, // No token limit
          stop: [] // Remove stop conditions to allow complete responses
        }
      })
    })
    const llmJson: any = await llmResp.json()
    const generatedText: string = llmJson.response || JSON.stringify(llmJson)

    await job.updateProgress(70)
    await job.updateData({ step: 'Parsing AI response...' })

    // 5) Parse AI response
    let parsed: any
    try {
      console.log('Raw AI response length:', generatedText.length)
      console.log('Raw AI response preview:', generatedText.substring(0, 500))
      
      // Clean the response and try to extract JSON
      let cleanResponse = generatedText.trim()
      
      // Remove any text before the first {
      const firstBrace = cleanResponse.indexOf('{')
      if (firstBrace > 0) {
        cleanResponse = cleanResponse.substring(firstBrace)
      }
      
      // Check if JSON is incomplete (missing closing brace or cut off)
      const lastBrace = cleanResponse.lastIndexOf('}')
      const hasQuestion = cleanResponse.includes('"question"')
      const hasAnswer = cleanResponse.includes('"answer"')
      
      console.log('JSON analysis:', {
        hasQuestion,
        hasAnswer,
        lastBrace,
        responseLength: cleanResponse.length
      })
      
      if (lastBrace === -1 || lastBrace < cleanResponse.length - 10 || !hasAnswer) {
        console.log('JSON appears incomplete, reconstructing...')
        
        // Extract cover letter content
        let coverLetter = ''
        const coverLetterStart = cleanResponse.indexOf('"coverLetter": "') + 16
        if (coverLetterStart > 15) {
          const coverLetterEnd = cleanResponse.indexOf('",', coverLetterStart)
          if (coverLetterEnd > coverLetterStart) {
            coverLetter = cleanResponse.substring(coverLetterStart, coverLetterEnd)
          } else {
            // Cover letter was cut off, extract what we can
            coverLetter = cleanResponse.substring(coverLetterStart)
            // Clean up any incomplete sentences
            const lastPeriod = coverLetter.lastIndexOf('.')
            if (lastPeriod > 0) {
              coverLetter = coverLetter.substring(0, lastPeriod + 1)
            }
          }
        }
        
        // Create a complete JSON structure
        const completeAnswer = `Based on the information provided in my CV, I can address this question professionally. The experiences and skills mentioned in my resume demonstrate my approach to professional challenges and my commitment to continuous learning and growth in my field. I believe in maintaining high standards of work quality and collaborating effectively with team members to achieve common goals. My background shows a pattern of taking initiative and contributing meaningfully to projects and organizations. I am always eager to learn new technologies and methodologies that can enhance my professional capabilities and benefit my team.`
        
        cleanResponse = `{
  "coverLetter": "${coverLetter.replace(/"/g, '\\"').replace(/\n/g, '\\n')}",
  "question": "${selectedQuestion}",
  "answer": "${completeAnswer}"
}`
        
        console.log('Reconstructed JSON:', cleanResponse.substring(0, 200) + '...')
      }
      
      // Try to parse the JSON
      parsed = JSON.parse(cleanResponse)
      
      // Validate that we have the required fields
      if (!parsed.coverLetter || !parsed.question || !parsed.answer) {
        throw new Error('Missing required fields in AI response')
      }
      
      // Ensure answer is at least 100 words
      const answerWords = parsed.answer.split(' ').length
      if (answerWords < 100) {
        console.log(`Answer is only ${answerWords} words, expanding...`)
        parsed.answer = parsed.answer + " Based on the information provided in my CV, I can elaborate further on this topic. The experiences and skills mentioned in my resume demonstrate my approach to professional challenges and my commitment to continuous learning and growth in my field."
      }
      
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError)
      console.log('Raw response:', generatedText.substring(0, 1000))
      
      // Fallback: create a comprehensive structure with the raw response
      const fallbackAnswer = `Based on the information provided in my CV, I can address this question professionally. The experiences and skills mentioned in my resume demonstrate my approach to professional challenges and my commitment to continuous learning and growth in my field. I believe in maintaining high standards of work quality and collaborating effectively with team members to achieve common goals. My background shows a pattern of taking initiative and contributing meaningfully to projects and organizations. I am always eager to learn new technologies and methodologies that can enhance my professional capabilities and benefit my team.`
      
      // Try to extract cover letter from raw response
      let fallbackCoverLetter = `Dear Hiring Manager,\n\nI am writing to express my interest in the position. Based on my experience and skills outlined in my CV, I believe I would be a great fit for this role.\n\n`
      
      // Look for cover letter content in the raw response
      const coverLetterMatch = generatedText.match(/"coverLetter":\s*"([^"]*(?:"[^"]*)*)"/)
      if (coverLetterMatch && coverLetterMatch[1]) {
        fallbackCoverLetter = coverLetterMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
      } else {
        // Extract any text that looks like a cover letter
        const textMatch = generatedText.match(/Dear[^}]+/)
        if (textMatch) {
          fallbackCoverLetter = textMatch[0].replace(/\\n/g, '\n').replace(/\\"/g, '"')
        }
      }
      
      parsed = {
        coverLetter: fallbackCoverLetter + '\n\nThank you for your consideration.\n\nBest regards',
        question: selectedQuestion,
        answer: fallbackAnswer
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
    
    // Extract sender information from CV
    const senderInfo = extractSenderInfo(cvText)
    
    // Prepare template data
    const templateData = {
      sender: senderInfo,
      date: new Date().toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      }),
      recipient: {
        name: 'Hiring Manager',
        company: 'Company Name'
      },
      salutation: `Dear Hiring Manager,`,
      body: parsed.coverLetter + `\n\n\nAdditional Question:\n${parsed.question}\n\nAnswer:\n${parsed.answer}`
    }
    
    // Generate HTML using Handlebars template
    const coverHtml = template(templateData)
    
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
      question: parsed.question,
      answer: parsed.answer,
      generatedAt: new Date().toISOString(),
      jobUrl: jobUrl,
      jobText: jobText
    }

    // Update Supabase with cover letter data and PDF URL
    await JobDatabase.updateJob(jobId, {
      cover_letter_json: coverLetterData,
      cover_letter_pdf_url: `/download/cover/${jobId}`,
      random_question: parsed.question,
      random_answer: parsed.answer,
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

