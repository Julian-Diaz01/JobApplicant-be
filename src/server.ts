import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import fs from 'fs'
import path from 'path'
import { uploadMiddleware } from './cvProcessor'
import { JobDatabase, JobRecord } from './supabase'

const app = express();
const PORT = process.env.PORT || 1010;

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Redis connection
const connection = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
})

// Create queue
const queue = new Queue('generate', { connection })

// In-memory storage for job status (Redis will handle the actual processing)
const jobStatus = new Map<string, any>()

// Listen for job events to update status
queue.on('progress', async (job, progress) => {
  const jobId = job.data.jobId
  if (jobStatus.has(jobId)) {
    const currentStatus = jobStatus.get(jobId)
    jobStatus.set(jobId, {
      ...currentStatus,
      status: 'processing',
      progress: progress,
      step: job.data.step || 'Processing...'
    })
  }
  
  // Update Supabase
  await JobDatabase.updateJob(jobId, {
    status: 'processing',
    progress: Number(progress),
    current_step: job.data.step || 'Processing...'
  })
})

queue.on('completed' as any, async (job: any) => {
  const jobId = job.data.jobId
  if (jobStatus.has(jobId)) {
    const currentStatus = jobStatus.get(jobId)
    jobStatus.set(jobId, {
      ...currentStatus,
      status: 'completed',
      progress: 100,
      step: 'Completed!',
      completedAt: new Date().toISOString()
    })
  }
  
  // Update Supabase
  await JobDatabase.updateJob(jobId, {
    status: 'completed',
    progress: 100,
    current_step: 'Completed!',
    completed_at: new Date().toISOString()
  })
})

queue.on('failed' as any, async (job: any, err: any) => {
  const jobId = job.data.jobId
  if (jobStatus.has(jobId)) {
    const currentStatus = jobStatus.get(jobId)
    jobStatus.set(jobId, {
      ...currentStatus,
      status: 'failed',
      error: err.message,
      step: 'Failed'
    })
  }
  
  // Update Supabase
  await JobDatabase.updateJob(jobId, {
    status: 'failed',
    error_message: err.message,
    current_step: 'Failed'
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Job Applicant API is running (Redis mode)' });
});

// Get all jobs from Supabase
app.get('/jobs', async (req, res) => {
  try {
    const jobs = await JobDatabase.getAllJobs()
    res.json({
      success: true,
      jobs: jobs
    })
  } catch (error) {
    console.error('Error getting jobs:', error)
    res.status(500).json({ error: 'Failed to get jobs' })
  }
})

// Get specific job from Supabase
app.get('/jobs/:jobId', async (req, res) => {
  try {
    const jobId = req.params.jobId
    const job = await JobDatabase.getJob(jobId)
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' })
    }
    
    res.json({
      success: true,
      job: job
    })
  } catch (error) {
    console.error('Error getting job:', error)
    res.status(500).json({ error: 'Failed to get job' })
  }
})

// Upload CV and Job Offer - Process Together
app.post('/process', (req, res) => {
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
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    try {
      // Extract company name from job description or URL
      let companyName = 'Unknown Company'
      if (jobText) {
        // Try to extract company name from job description
        const companyMatch = jobText.match(/(?:at|@|Company:|Employer:)\s*([A-Za-z\s&.,-]+)/i)
        if (companyMatch) {
          companyName = companyMatch[1].trim()
        }
      }

      // Store initial job status immediately
      jobStatus.set(jobId, {
        id: jobId,
        status: 'queued',
        progress: 0,
        step: 'Uploading files...',
        createdAt: new Date().toISOString()
      })

      // Save job to Supabase
      const jobRecord: Partial<JobRecord> = {
        job_id: jobId,
        company_name: companyName,
        job_url: jobUrl,
        job_description: jobText,
        cv_file_name: req.file.originalname,
        status: 'pending',
        progress: 0,
        current_step: 'Uploading files...'
      }

      await JobDatabase.createJob(jobRecord)

      // Add to Redis queue for processing (worker will handle PDF extraction and AI processing)
      const payload = { 
        jobId,
        filePath,  // Pass file path instead of extracted text
        jobUrl, 
        jobText
      }
      
      await queue.add('generate-cv', payload, { 
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 10,
        removeOnFail: 5
      })
      
      res.json({
        success: true,
        message: 'CV and job offer submitted for processing',
        jobId,
        status: 'queued'
      })

    } catch (error) {
      console.error('Processing error:', error)
      
      // Update job status to failed
      if (jobStatus.has(jobId)) {
        jobStatus.set(jobId, {
          ...jobStatus.get(jobId),
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
      
      res.status(500).json({ 
        error: 'Failed to process CV and job offer',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  })
})

// Check job status
app.get('/status/:jobId', async (req, res) => {
  const jobId = req.params.jobId
  
  try {
    // Check if job exists in our memory
    const status = jobStatus.get(jobId)
    if (!status) {
      return res.status(404).json({ error: 'Job not found' })
    }

    // Try to get job from queue for real-time status
    const jobs = await queue.getJobs(['waiting', 'active', 'completed', 'failed'])
    const queueJob = jobs.find(job => job.data.jobId === jobId)
    
    if (queueJob) {
      const queueState = await queueJob.getState()
      const progress = queueJob.progress || 0
      
      // Update our status based on queue state
      if (queueState === 'completed') {
        jobStatus.set(jobId, {
          ...status,
          status: 'completed',
          progress: 100,
          completedAt: new Date().toISOString()
        })
      } else if (queueState === 'failed') {
        jobStatus.set(jobId, {
          ...status,
          status: 'failed',
          error: queueJob.failedReason || 'Unknown error'
        })
      } else if (queueState === 'active') {
        jobStatus.set(jobId, {
          ...status,
          status: 'processing',
          progress: progress
        })
      }
    }
    
    const currentStatus = jobStatus.get(jobId)
        res.json({
          jobId: currentStatus.id,
          status: currentStatus.status,
          progress: currentStatus.progress,
          step: currentStatus.step || 'Processing...',
          error: currentStatus.error,
          createdAt: currentStatus.createdAt,
          completedAt: currentStatus.completedAt
        })
  } catch (error) {
    console.error('Error checking job status:', error)
    res.status(500).json({ error: 'Failed to check job status' })
  }
})

// Download generated files
app.get('/download/:type/:jobId', (req, res) => {
  const { type, jobId } = req.params
  const status = jobStatus.get(jobId)
  
  if (!status) {
    return res.status(404).json({ error: 'Job not found' })
  }
  
  if (status.status !== 'completed') {
    return res.status(400).json({ error: 'Job not completed yet' })
  }
  
  // Only allow cover letter downloads
  if (type !== 'cover') {
    return res.status(400).json({ error: 'Invalid download type. Only "cover" is supported.' })
  }
  
  const filePath = path.resolve(`out/${type}-${jobId}.pdf`)
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Cover letter not found' })
  }
  
  res.download(filePath, `cover-letter-${jobId}.pdf`)
})

// Clean up completed jobs
app.delete('/cleanup/:jobId', (req, res) => {
  const jobId = req.params.jobId
  const status = jobStatus.get(jobId)
  
  if (!status) {
    return res.status(404).json({ error: 'Job not found' })
  }
  
  try {
    // Remove job from memory
    jobStatus.delete(jobId)
    
    // Clean up generated files
    const coverPath = path.resolve(`out/cover-${jobId}.pdf`)
    const cvPath = path.resolve(`out/cv-${jobId}.pdf`)
    
    if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath)
    if (fs.existsSync(cvPath)) fs.unlinkSync(cvPath)
    
    res.json({ success: true, message: 'Job and files cleaned up' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to cleanup job' })
  }
})

// Note: Queue event listeners removed for simplicity
// Job status updates will be handled by polling the queue directly

app.get('/', (req, res) => {
  res.json({ 
    message: 'Job Applicant Backend API - Redis Version',
    version: '2.0.0',
    flow: 'Upload CV + Job Offer → Queue → Worker Processes → Real-time Updates → Download Cover Letter',
        endpoints: {
          health: 'GET /health',
          process: 'POST /process (multipart/form-data with cv file + jobUrl/jobText)',
          status: 'GET /status/:jobId',
          downloadCover: 'GET /download/cover/:jobId',
          cleanup: 'DELETE /cleanup/:jobId'
        },
        usage: {
          step1: 'POST /process with cv file and jobUrl or jobText',
          step2: 'GET /status/:jobId to check progress (real-time updates)',
          step3: 'GET /download/cover/:jobId when completed'
        },
        features: {
          redis: 'Queue-based processing with Redis',
          scalability: 'Can handle multiple concurrent requests',
          progress: 'Real-time progress tracking',
          retry: 'Automatic retry on failures',
          persistence: 'Jobs survive server restarts',
          focus: 'Cover letter generation only (uses provided CV)'
        }
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT} (Redis mode)`);
  console.log('Make sure to start the worker: npm run dev-worker');
});
