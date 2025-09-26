import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer'
import handlebars from 'handlebars'
import { uploadMiddleware, extractTextFromPDF, cleanupFile } from './cvProcessor'
import { QuestionDatabase } from './supabase'

const app = express();
const PORT = process.env.PORT || 1010;

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

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

// Function to generate PDF from cover letter data
async function generateCoverLetterPDF(sessionId: string, coverLetter: string, cvText: string): Promise<string> {
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
    body: coverLetter
  }
  
  // Generate HTML using Handlebars template
  const coverHtml = template(templateData)
  
  // Generate Cover Letter PDF
  await page.setContent(coverHtml, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const coverPdfPath = path.resolve(`out/cover-${sessionId}.pdf`)
  await page.pdf({ path: coverPdfPath, format: 'A4', timeout: 60000 })

  await browser.close()
  
  return coverPdfPath
}

// Function to call LLM for chat responses
async function callLLM(messages: any[], cvText: string, jobDescription: string): Promise<string> {
  try {
    // Build conversation context
    let conversationContext = `You are a helpful assistant for job application support. You help users create cover letters and answer job-related questions.

CV CONTENT:
${cvText}

JOB DESCRIPTION:
${jobDescription}

CONVERSATION HISTORY:
`

    // Add recent conversation history (last 10 messages)
    const recentMessages = messages.slice(-10)
    for (const msg of recentMessages) {
      conversationContext += `${msg.role}: ${msg.message}\n`
    }

    conversationContext += `\nPlease provide a helpful response based on the CV, job description, and conversation history. Be specific and actionable.`

    const llmResp = await fetch(process.env.OLLAMA_URL || 'http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.2',
        prompt: conversationContext,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 1000
        }
      })
    })

    if (!llmResp.ok) {
      throw new Error(`LLM API returned status ${llmResp.status}: ${llmResp.statusText}`)
    }

    const llmJson: any = await llmResp.json()
    return llmJson.response || 'I apologize, but I encountered an error generating a response.'

  } catch (error) {
    console.error('Error calling LLM:', error)
    return 'I apologize, but I encountered an error generating a response. Please try again.'
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Job Applicant Local Chat API is running' });
});

// Start new chat session (returns session data for local storage)
app.post('/chat/start', (req, res) => {
  uploadMiddleware(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err)
      return res.status(400).json({ error: err.message })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No CV file uploaded' })
    }

    const { jobUrl, jobText } = req.body
    
    if (!jobUrl && !jobText) {
      return res.status(400).json({ error: 'Either jobUrl or jobText is required' })
    }

    const filePath = req.file.path
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    try {
      // Extract text from CV
      const cvText = await extractTextFromPDF(filePath)
      
      if (!cvText || cvText.trim().length === 0) {
        return res.status(400).json({ error: 'No text could be extracted from the CV PDF' })
      }

      // Extract company name using LLM
      let companyName = 'Not Found'
      let llmInput = ''
      if (jobText) {
        llmInput += `Job Description:\n${jobText.substring(0, 2000)}\n\n`
      }
      if (jobUrl) {
        llmInput += `Job URL: ${jobUrl}\n\n`
      }
      
      if (llmInput.trim()) {
        try {
          const llmResp = await fetch(process.env.OLLAMA_URL || 'http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: process.env.OLLAMA_MODEL || 'llama3.2',
              prompt: `Extract the company name from this job posting or URL. Return ONLY the company name, maximum 3 words. If no clear company name is found, return "Not Found".

${llmInput}

Company Name:`,
              stream: false,
              options: {
                temperature: 0.1,
                num_predict: 30
              }
            })
          })
          
          if (llmResp.ok) {
            const llmJson = await llmResp.json()
            const extractedName = (llmJson.response || '').trim()
            
            if (!extractedName.toLowerCase().includes('not found') && 
                extractedName.length >= 2 && extractedName.length <= 50) {
              companyName = extractedName
            }
          }
        } catch (llmError) {
          console.error('Error extracting company name:', llmError)
        }
      }

      // Create session data for local storage
      const sessionData = {
        session_id: sessionId,
        company_name: companyName,
        job_url: jobUrl,
        job_description: jobText,
        cv_file_name: req.file.originalname,
        cv_text: cvText,
        status: 'active',
        created_at: new Date().toISOString()
      }

      // Clean up the uploaded file
      cleanupFile(filePath)

      res.json({
        success: true,
        session: sessionData,
        welcomeMessage: `Hello! I'm here to help you create a cover letter for the ${companyName} position. I've reviewed your CV and the job description. What would you like to focus on first?`
      })

    } catch (error) {
      console.error('Error starting chat session:', error)
      cleanupFile(filePath)
      res.status(500).json({ 
        error: 'Failed to start chat session',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  })
})

// Send message to chat (processes locally, saves question to database)
app.post('/chat/message', async (req, res) => {
  const { session, message } = req.body

  if (!session || !message || message.trim().length === 0) {
    return res.status(400).json({ error: 'Session and message are required' })
  }

  try {
    // Save question to database for analytics
    await QuestionDatabase.saveQuestion({
      question_text: message.trim(),
      question_type: 'general',
      company_name: session.company_name
    })

    // Get conversation history from session
    const messages = session.messages || []

    // Add user message to conversation
    const userMessage = {
      role: 'user',
      message: message.trim(),
      timestamp: new Date().toISOString()
    }
    messages.push(userMessage)

    // Call LLM for response
    const llmResponse = await callLLM(messages, session.cv_text || '', session.job_description || '')

    // Add assistant response to conversation
    const assistantMessage = {
      role: 'assistant',
      message: llmResponse,
      timestamp: new Date().toISOString()
    }
    messages.push(assistantMessage)

    // Return updated session with new messages
    const updatedSession = {
      ...session,
      messages: messages
    }

    res.json({
      success: true,
      session: updatedSession,
      response: llmResponse
    })

  } catch (error) {
    console.error('Error processing chat message:', error)
    res.status(500).json({ 
      error: 'Failed to process message',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// Generate PDF for cover letter
app.post('/chat/generate-pdf', async (req, res) => {
  const { session, coverLetter } = req.body

  if (!session || !coverLetter) {
    return res.status(400).json({ error: 'Session and cover letter are required' })
  }

  try {
    // Check if PDF already exists
    const filePath = path.resolve(`out/cover-${session.session_id}.pdf`)
    if (fs.existsSync(filePath)) {
      return res.json({ 
        success: true, 
        message: 'PDF already exists',
        downloadUrl: `/chat/download-pdf/${session.session_id}`
      })
    }

    // Generate PDF
    console.log(`Generating PDF for session ${session.session_id}...`)
    await generateCoverLetterPDF(session.session_id, coverLetter, session.cv_text || '')

    res.json({ 
      success: true, 
      message: 'PDF generated successfully',
      downloadUrl: `/chat/download-pdf/${session.session_id}`
    })

  } catch (error) {
    console.error('Error generating PDF:', error)
    res.status(500).json({ 
      error: 'Failed to generate PDF',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// Download PDF
app.get('/chat/download-pdf/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId

  try {
    const filePath = path.resolve(`out/cover-${sessionId}.pdf`)
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'PDF not found. Please generate it first.' })
    }

    res.download(filePath, `cover-letter-${sessionId}.pdf`)

  } catch (error) {
    console.error('Error downloading PDF:', error)
    res.status(500).json({ 
      error: 'Failed to download PDF',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// Get all questions (for admin purposes)
app.get('/questions', async (req, res) => {
  try {
    const questions = await QuestionDatabase.getAllQuestions()
    res.json({
      success: true,
      questions
    })
  } catch (error) {
    console.error('Error getting questions:', error)
    res.status(500).json({ error: 'Failed to get questions' })
  }
})

// API documentation
app.get('/', (req, res) => {
  res.json({ 
    message: 'Job Applicant Local Chat API',
    version: '4.0.0',
    flow: 'Upload CV + Job → Get Session Data → Local Chat → Save Questions → Generate PDF',
    endpoints: {
      health: 'GET /health',
      startChat: 'POST /chat/start (multipart/form-data with cv file + jobUrl/jobText)',
      sendMessage: 'POST /chat/message (with session and message)',
      generatePdf: 'POST /chat/generate-pdf (with session and coverLetter)',
      downloadPdf: 'GET /chat/download-pdf/:sessionId',
      getQuestions: 'GET /questions'
    },
    usage: {
      step1: 'POST /chat/start with cv file and jobUrl or jobText',
      step2: 'POST /chat/message to chat with AI (session stays local)',
      step3: 'POST /chat/generate-pdf to create PDF from cover letter',
      step4: 'GET /chat/download-pdf/:sessionId to download'
    },
    features: {
      privacy: 'All chat data stays local, only questions saved to database',
      interactive: 'Real-time chat with AI for cover letter assistance',
      revisions: 'Multiple revisions and iterations',
      pdf: 'Generate PDF from cover letter',
      analytics: 'Questions saved for analytics only'
    }
  });
});

app.listen(PORT, () => {
  console.log(`Local chat server is running on port ${PORT}`);
});
