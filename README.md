# Job Applicant Backend API

A Node.js/TypeScript backend service that automatically generates tailored CVs and cover letters for job applications using AI.

## Features

- **Job Content Extraction**: Automatically extracts job posting content from URLs or accepts direct text input
- **AI-Powered Generation**: Uses Ollama (local LLM) to generate tailored cover letters and CV bullet points
- **PDF Generation**: Creates professional PDF documents using Handlebars templates and Puppeteer
- **Queue-Based Processing**: Uses BullMQ with Redis for reliable job processing
- **RESTful API**: Clean API endpoints for profile management and job submission

## Tech Stack

- **Backend**: Node.js, TypeScript, Express
- **Queue System**: BullMQ with Redis
- **AI/LLM**: Ollama (local LLM server)
- **PDF Generation**: Puppeteer + Handlebars templates
- **Content Extraction**: JSDOM + Mozilla Readability
- **Containerization**: Docker + Docker Compose

## API Endpoints

- `GET /` - API information and available endpoints
- `GET /health` - Health check
- `POST /profiles` - Create a new applicant profile
- `GET /profiles/:id` - Get profile by ID
- `POST /jobs` - Submit a job application request
- `GET /jobs/:id` - Get job status and results
- `GET /download/cover/:jobId` - Download generated cover letter PDF
- `GET /download/cv/:jobId` - Download generated CV PDF

## Quick Start

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Ollama (for local LLM)

### Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start Redis**:
   ```bash
   docker run -d --name redis -p 6379:6379 redis:7-alpine
   ```

3. **Start Ollama**:
   ```bash
   ollama serve
   ollama pull llama3.2
   ```

4. **Build and start the application**:
   ```bash
   npm run build
   npm start
   ```

5. **Start the worker** (in another terminal):
   ```bash
   node out/worker.js
   ```

### Docker Compose

```bash
docker-compose up --build
```

This will start:
- Redis (port 6379)
- Ollama (port 11434)
- API Server (port 1010)
- Worker process

## Usage Example

1. **Create a profile**:
   ```bash
   curl -X POST http://localhost:1010/profiles \
     -H "Content-Type: application/json" \
     -d '{
       "name": "John Doe",
       "email": "john@example.com",
       "phone": "+1234567890",
       "skills": ["React", "TypeScript", "Node.js"],
       "experience": "5 years frontend development"
     }'
   ```

2. **Submit a job application**:
   ```bash
   curl -X POST http://localhost:1010/jobs \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://example.com/job-posting",
       "profileId": "profile_1234567890"
     }'
   ```

3. **Check job status**:
   ```bash
   curl http://localhost:1010/jobs/1
   ```

4. **Download generated PDFs**:
   ```bash
   curl -O http://localhost:1010/download/cover/1
   curl -O http://localhost:1010/download/cv/1
   ```

## Environment Variables

- `PORT` - Server port (default: 1010)
- `OLLAMA_URL` - Ollama API URL (default: http://localhost:11434/api/generate)
- `OLLAMA_MODEL` - Ollama model name (default: llama3.2)

## Project Structure

```
├── src/
│   ├── server.ts      # Express API server
│   └── worker.ts      # BullMQ worker for job processing
├── templates/
│   ├── cover.hbs      # Cover letter template
│   └── cv.hbs         # CV template
├── out/               # Compiled JavaScript output
├── docker-compose.yml # Docker services configuration
├── Dockerfile         # Application container
└── package.json       # Dependencies and scripts
```

## License

ISC
