import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ modelId: string }> }
) {
  const { modelId } = await params
  const payload = await request.json()

  const supabase = await createClient()

  const { data: model, error: modelError } = await supabase
    .from('models')
    .select('*')
    .eq('id', modelId)
    .single()

  if (modelError || !model) {
    return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  }

  return NextResponse.json({
    modelId,
    payload,
    note: 'Prediction route scaffold ready for real model inference logic.',
  })
}
