-- Supabase Schema for Job Applicant API
-- This schema stores job processing data including cover letters and job details

-- Create jobs table to store processing information
CREATE TABLE jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id TEXT UNIQUE NOT NULL, -- Our internal job ID
  company_name TEXT,
  job_title TEXT,
  job_url TEXT,
  job_description TEXT,
  cv_file_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
  progress INTEGER DEFAULT 0,
  current_step TEXT,
  cover_letter_json JSONB, -- Store the AI-generated cover letter data
  cover_letter_pdf_url TEXT, -- URL to the generated PDF
  random_question TEXT, -- The random question asked
  random_answer TEXT, -- The answer to the random question
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Create an index on job_id for faster lookups
CREATE INDEX idx_jobs_job_id ON jobs(job_id);

-- Create an index on status for filtering
CREATE INDEX idx_jobs_status ON jobs(status);

-- Create an index on created_at for sorting
CREATE INDEX idx_jobs_created_at ON jobs(created_at);

-- Create a function to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_jobs_updated_at 
    BEFORE UPDATE ON jobs 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows all operations (for now)
-- In production, you might want to restrict this based on user authentication
CREATE POLICY "Allow all operations on jobs" ON jobs
    FOR ALL USING (true);

-- Insert some sample data (optional)
-- INSERT INTO jobs (job_id, company_name, job_title, job_description, status) 
-- VALUES ('sample_job_123', 'Tech Corp', 'Software Engineer', 'Looking for a skilled developer...', 'completed');