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
export interface Question {
  id?: string
  question_text: string
  question_type?: 'general' | 'cover_letter' | 'revision'
  company_name?: string
  created_at?: string
}

// Database operations
export class QuestionDatabase {
  // Save a question for analytics
  static async saveQuestion(questionData: Partial<Question>): Promise<Question | null> {
    try {
      const { data, error } = await supabase
        .from('questions')
        .insert([questionData])
        .select()
        .single()

      if (error) {
        console.error('Error saving question:', error)
        return null
      }

      return data
    } catch (error) {
      console.error('Error saving question:', error)
      return null
    }
  }

  // Get all questions (for admin purposes)
  static async getAllQuestions(): Promise<Question[]> {
    try {
      const { data, error } = await supabase
        .from('questions')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) {
        console.error('Error getting all questions:', error)
        return []
      }

      return data || []
    } catch (error) {
      console.error('Error getting all questions:', error)
      return []
    }
  }
}
