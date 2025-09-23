import express from 'express'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import fs from 'fs'
import path from 'path'

const app = express();
const PORT = process.env.PORT || 1010;

app.use(express.json());

const connection = new IORedis() // default localhost:6379
const queue = new Queue('generate', { connection })

// In-memory storage for profiles (in production, use a database)
const profiles = new Map<string, any>()

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Job Applicant API is running' });
});

// Profile management endpoints
app.post('/profiles', (req, res) => {
  const profile = req.body
  const profileId = `profile_${Date.now()}`
  profiles.set(profileId, profile)
  res.json({ profileId, profile })
})

app.get('/profiles/:id', (req, res) => {
  const profile = profiles.get(req.params.id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }
  res.json({ profileId: req.params.id, profile })
})

// Job submission endpoint
app.post('/jobs', async (req, res) => {
  const { url, text, profileId } = req.body
  
  if (!url && !text) {
    return res.status(400).json({ error: 'Either url or text is required' })
  }
  
  if (!profileId) {
    return res.status(400).json({ error: 'profileId is required' })
  }
  
  const profile = profiles.get(profileId)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }
  
  const payload = { url, text, profile }
  const job = await queue.add('generate-cv', payload, { attempts: 3 })
  res.json({ jobId: job.id })
})

// Job status endpoint
app.get('/jobs/:id', async (req, res) => {
  const job = await queue.getJob(req.params.id)
  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }
  
  const state = await job.getState()
  const result = job.returnvalue
  
  res.json({
    jobId: job.id,
    state,
    progress: job.progress,
    result,
    data: job.data
  })
})

// Download generated PDFs
app.get('/download/:type/:jobId', (req, res) => {
  const { type, jobId } = req.params
  const filePath = path.resolve(`out/${type}-${jobId}.pdf`)
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' })
  }
  
  res.download(filePath)
})

app.get('/', (req, res) => {
  res.json({ 
    message: 'Job Applicant Backend API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      createProfile: 'POST /profiles',
      getProfile: 'GET /profiles/:id',
      submitJob: 'POST /jobs',
      getJobStatus: 'GET /jobs/:id',
      downloadCover: 'GET /download/cover/:jobId',
      downloadCV: 'GET /download/cv/:jobId'
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

