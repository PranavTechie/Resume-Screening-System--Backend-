import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { geminiService } from '../services/ai/gemini.service';
import { logger } from './logger';

export async function extractTextFromFile(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const lowerName = filename.toLowerCase();

  try {
    if (mimeType.includes('pdf') || lowerName.endsWith('.pdf')) {
      const pdfStart = Date.now();
      let text = '';
      try {
        const parsed = await pdfParse(buffer);
        text = (parsed.text || '').trim();
        const duration = Date.now() - pdfStart;
        logger.info(`[ResumeAPI] PDF local text extraction finished in ${duration}ms: pages=${parsed.numpages || 1}, textLength=${text.length}`);
      } catch (pdfErr: any) {
        logger.warn(`[ResumeAPI] PDF local text parsing exception: "${pdfErr.message}". Routing to Gemini multimodal document reader.`);
      }

      // If normal text PDF with sufficient readable text, return immediately (fast, 0 AI overhead)
      if (text.length >= 50) {
        return text;
      }

      // Scanned or image-converted PDF (e.g. png2pdf.pdf): route to Gemini multimodal
      logger.info(`[ResumeAPI] PDF "${filename}" has near-zero text (${text.length} chars). Routing to Gemini multimodal document reader...`);
      const ocrText = await geminiService.extractTextFromMultimodalDocument(buffer, 'application/pdf', filename);
      return ocrText || '';
    }

    if (
      mimeType.includes('wordprocessingml') ||
      mimeType.includes('msword') ||
      lowerName.endsWith('.docx') ||
      lowerName.endsWith('.doc')
    ) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    }

    if (mimeType.includes('text') || lowerName.endsWith('.txt')) {
      return buffer.toString('utf-8');
    }

    if (
      mimeType.startsWith('image/') ||
      mimeType.includes('image/jpeg') ||
      mimeType.includes('image/jpg') ||
      mimeType.includes('image/png') ||
      mimeType.includes('image/webp') ||
      lowerName.endsWith('.jpg') ||
      lowerName.endsWith('.jpeg') ||
      lowerName.endsWith('.png') ||
      lowerName.endsWith('.webp')
    ) {
      const ocrText = await geminiService.extractTextFromMultimodalDocument(buffer, mimeType, filename);
      return ocrText || '';
    }

    // Default string conversion fallback
    return buffer.toString('utf-8');
  } catch (err: any) {
    if (err.message && err.message.includes("couldn't read enough text")) {
      throw err;
    }
    logger.warn(`Text extraction error for file ${filename}: ${err.message}.`);
    throw err;
  }
}
