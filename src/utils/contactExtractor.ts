/**
 * High-accuracy utility for extracting candidate contact information (email & phone)
 * directly from raw resume text.
 * 
 * Rules & Constraints:
 * - Only extract contact information belonging to the candidate from the actual resume text.
 * - Prioritize header/contact sections (first ~2,500 characters of the document).
 * - Support Indian, US, and international phone formats.
 * - Filter out date ranges, percentages, zip codes, and invalid email domains.
 * - Return null if uncertain rather than hallucinating or guessing.
 */

export interface ExtractedContact {
  email: string | null;
  phone: string | null;
}

/**
 * Validates whether an email string has a standard valid format.
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 100) return false;

  // Basic structure check
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(trimmed)) return false;

  // Ignore image assets that contain @
  if (/\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(trimmed)) return false;

  // Exclude placeholder/example emails
  const lower = trimmed.toLowerCase();
  if (
    lower.includes('yourname@') ||
    lower.includes('example.com') ||
    lower.includes('domain.com') ||
    lower.includes('placeholder') ||
    lower.includes('email@email.com')
  ) {
    return false;
  }

  return true;
}

/**
 * Validates and normalizes phone number candidates.
 */
export function normalizePhone(rawPhone: string): string | null {
  if (!rawPhone || typeof rawPhone !== 'string') return false ? '' : null;
  let cleaned = rawPhone.trim();

  // Strip phone prefix labels like "Phone:", "Tel:", "Mobile:", "Cell:", "Ph:"
  cleaned = cleaned.replace(/^(?:phone|telephone|tel|mobile|cell|contact|ph|m)[\s.:#-]*/i, '').trim();

  // Strip trailing punctuation
  cleaned = cleaned.replace(/[.,;:|/\\-]+$/, '').trim();

  // Count digits
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }

  // Reject years and date ranges (e.g. "2018 - 2022" has 8 digits, but let's be strict on 4-digit pairs)
  if (/^\d{4}\s*[-–—]\s*\d{4}$/.test(cleaned)) {
    return null;
  }

  // Reject repetitive single digits like "0000000000" or "1111111111"
  if (/^(\d)\1{9,}$/.test(digits)) {
    return null;
  }

  // Reject if it looks like a credit card (16 digits) or pure zip code
  if (digits.length === 16) {
    return null;
  }

  // Standardize spaces around country codes if messy
  return cleaned.replace(/\s+/g, ' ');
}

/**
 * Extracts candidate email from resume text.
 */
export function extractEmail(resumeText: string): string | null {
  if (!resumeText || typeof resumeText !== 'string') return null;

  // Candidate contact details are typically in the top 2,500 characters
  const headerText = resumeText.slice(0, 2500);
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  // Search header first
  const headerMatches = headerText.match(emailRegex);
  if (headerMatches) {
    for (const match of headerMatches) {
      if (isValidEmail(match)) {
        return match.trim().toLowerCase();
      }
    }
  }

  // Fallback to full document if not found in header
  const fullMatches = resumeText.match(emailRegex);
  if (fullMatches) {
    for (const match of fullMatches) {
      if (isValidEmail(match)) {
        return match.trim().toLowerCase();
      }
    }
  }

  return null;
}

/**
 * Extracts candidate phone number from resume text.
 */
export function extractPhone(resumeText: string): string | null {
  if (!resumeText || typeof resumeText !== 'string') return null;

  // Prioritize header (top 2,500 characters)
  const headerText = resumeText.slice(0, 2500);

  // 1. Look for labeled phone numbers first (highest precision)
  const labeledRegex = /(?:phone|telephone|tel|mobile|cell|contact|ph|m)[\s.:#-]*([+()0-9\s.-]{10,25})/gi;
  let match: RegExpExecArray | null;

  while ((match = labeledRegex.exec(headerText)) !== null) {
    const candidate = normalizePhone(match[1]);
    if (candidate) return candidate;
  }

  // 2. Look for Indian phone formats (+91 XXXXX XXXXX, +91-XXXXXXXXXX, 9XXXXXXXXX)
  // Indian mobile numbers begin with 6, 7, 8, or 9
  const indianRegex = /(?:(?:\+91|91)[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g;
  const indianMatches = headerText.match(indianRegex);
  if (indianMatches && indianMatches.length > 0) {
    const candidate = normalizePhone(indianMatches[0]);
    if (candidate) return candidate;
  }

  // 3. Look for US / International phone patterns
  // Examples: +1 (555) 123-4567, (555) 123-4567, 555-123-4567, +44 20 7946 0958
  const internationalRegex = /(?:\+(?:[1-9]\d{0,2})[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}\b/g;
  const intlMatches = headerText.match(internationalRegex);
  if (intlMatches) {
    for (const raw of intlMatches) {
      const candidate = normalizePhone(raw);
      if (candidate) return candidate;
    }
  }

  // Fallback to searching labeled phones in entire document
  while ((match = labeledRegex.exec(resumeText)) !== null) {
    const candidate = normalizePhone(match[1]);
    if (candidate) return candidate;
  }

  return null;
}

/**
 * Combined extractor that returns both email and phone.
 */
export function extractContactInfo(resumeText: string): ExtractedContact {
  return {
    email: extractEmail(resumeText),
    phone: extractPhone(resumeText),
  };
}
