-- Supabase Schema for Job Applicant Chat API
-- This schema stores only questions for analytics, all chat data stays local

-- Create questions table to store questions asked by users
CREATE TABLE questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question_text TEXT NOT NULL,
  question_type TEXT DEFAULT 'general', -- 'general', 'cover_letter', 'revision'
  company_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_questions_created_at ON questions(created_at);
CREATE INDEX idx_questions_company_name ON questions(company_name);
CREATE INDEX idx_questions_question_type ON questions(question_type);

-- Create a function to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Enable Row Level Security (RLS)
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

-- Create policy that allows all operations (for now)
-- In production, you might want to restrict this based on user authentication
CREATE POLICY "Allow all operations on questions" ON questions
    FOR ALL USING (true);