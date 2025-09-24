import multer from 'multer'
import pdf from 'pdf-parse'
import fs from 'fs'
import path from 'path'
import fetch from 'node-fetch'

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads'
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, `cv-${uniqueSuffix}.pdf`)
  }
})

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true)
    } else {
      cb(new Error('Only PDF files are allowed'))
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
})

export const uploadMiddleware = upload.single('cv')

// Extract text from PDF
export const extractTextFromPDF = async (filePath: string): Promise<string> => {
  try {
    const dataBuffer = fs.readFileSync(filePath)
    const data = await pdf(dataBuffer)
    return data.text
  } catch (error) {
    console.error('Error extracting text from PDF:', error)
    throw new Error('Failed to extract text from PDF')
  }
}

// Extract profile information from CV text using AI
export const extractProfileFromCV = async (cvText: string): Promise<any> => {
  try {
    const prompt = `
You are an expert at extracting structured information from CV/resume text.

CV Text:
${cvText}

Task:
Extract the following information and return ONLY valid JSON:

{
  "name": "Full name",
  "email": "Email address",
  "phone": "Phone number",
  "address": "Full address",
  "linkedin_url": "LinkedIn profile URL",
  "github_url": "GitHub profile URL", 
  "website_url": "Personal website URL",
  "summary": "Professional summary/about section",
  "experience": [
    {
      "title": "Job title",
      "company": "Company name",
      "location": "Location",
      "startDate": "Start date",
      "endDate": "End date or 'Present'",
      "description": "Job description/responsibilities",
      "achievements": ["achievement1", "achievement2"]
    }
  ],
  "education": [
    {
      "degree": "Degree name",
      "institution": "Institution name",
      "location": "Location",
      "startDate": "Start date",
      "endDate": "End date",
      "gpa": "GPA if mentioned",
      "relevant_courses": ["course1", "course2"]
    }
  ],
  "skills": [
    {
      "category": "Skill category (e.g., 'Programming Languages', 'Tools', 'Frameworks')",
      "items": ["skill1", "skill2", "skill3"]
    }
  ]
}

Rules:
- If information is not available, use null or empty array
- Extract dates in a consistent format
- For skills, group them by category
- Keep descriptions concise but informative
- Return ONLY the JSON object, no additional text
`

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

    // Parse the JSON response
    let parsed: any
    try {
      // Try to extract JSON from the response
      const jsonMatch = generatedText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      } else {
        throw new Error('No JSON found in response')
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError)
      // Fallback: return basic structure with extracted text
      parsed = {
        name: null,
        email: null,
        phone: null,
        address: null,
        linkedin_url: null,
        github_url: null,
        website_url: null,
        summary: cvText.substring(0, 500) + '...',
        experience: [],
        education: [],
        skills: []
      }
    }

    return parsed
  } catch (error) {
    console.error('Error extracting profile from CV:', error)
    throw new Error('Failed to extract profile information from CV')
  }
}

// Clean up uploaded file
export const cleanupFile = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (error) {
    console.error('Error cleaning up file:', error)
  }
}
