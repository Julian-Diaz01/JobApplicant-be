import { createClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://your-project.supabase.co'
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'your-anon-key'

if (!supabaseUrl || supabaseUrl === 'https://your-project.supabase.co') {
  console.warn('⚠️  Supabase URL not configured. Set SUPABASE_URL environment variable.')
}

if (!supabaseKey || supabaseKey === 'your-anon-key') {
  console.warn('⚠️  Supabase key not configured. Set SUPABASE_ANON_KEY environment variable.')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

// Database types
export interface JobRecord {
  id?: string
  job_id: string
  company_name?: string
  job_title?: string
  job_url?: string
  job_description?: string
  cv_file_name?: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  current_step?: string
  cover_letter_json?: any
  cover_letter_pdf_url?: string
  random_question?: string
  random_answer?: string
  error_message?: string
  created_at?: string
  updated_at?: string
  completed_at?: string
}

// Database operations
export class JobDatabase {
  // Create a new job record
  static async createJob(jobData: Partial<JobRecord>): Promise<JobRecord | null> {
    try {
      const { data, error } = await supabase
        .from('jobs')
        .insert([jobData])
        .select()
        .single()

      if (error) {
        console.error('Error creating job:', error)
        return null
      }

      return data
    } catch (error) {
      console.error('Error creating job:', error)
      return null
    }
  }

  // Update job status and progress
  static async updateJob(jobId: string, updates: Partial<JobRecord>): Promise<JobRecord | null> {
    try {
      const { data, error } = await supabase
        .from('jobs')
        .update(updates)
        .eq('job_id', jobId)
        .select()
        .single()

      if (error) {
        console.error('Error updating job:', error)
        return null
      }

      return data
    } catch (error) {
      console.error('Error updating job:', error)
      return null
    }
  }

  // Get job by job_id
  static async getJob(jobId: string): Promise<JobRecord | null> {
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('job_id', jobId)
        .single()

      if (error) {
        console.error('Error getting job:', error)
        return null
      }

      return data
    } catch (error) {
      console.error('Error getting job:', error)
      return null
    }
  }

  // Get all jobs (for admin purposes)
  static async getAllJobs(): Promise<JobRecord[]> {
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) {
        console.error('Error getting all jobs:', error)
        return []
      }

      return data || []
    } catch (error) {
      console.error('Error getting all jobs:', error)
      return []
    }
  }

  // Delete job
  static async deleteJob(jobId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('jobs')
        .delete()
        .eq('job_id', jobId)

      if (error) {
        console.error('Error deleting job:', error)
        return false
      }

      return true
    } catch (error) {
      console.error('Error deleting job:', error)
      return false
    }
  }
}
