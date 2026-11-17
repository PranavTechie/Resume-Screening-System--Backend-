import { geminiService } from '../services/ai/gemini.service';

async function testExtraction() {
  console.log('--- Testing Contact Extraction ---');

  const resumeText = `
Name: Pranav Kadam
Phone: +91 9876543210
Email: pranav@example.com
LinkedIn: linkedin.com/in/pranavkadam
GitHub: https://github.com/pranavkadam
Website: pranav.dev

Experience: Software Engineer at Tech Co.
`;

  const result = await geminiService.analyzeResume(resumeText, 'pranav.pdf');

  console.log('--- Extracted Contact Info ---');
  console.log('Email:', result.candidateEmail);
  console.log('Phone:', result.candidatePhone);
  console.log('LinkedIn:', result.candidateLinkedIn);
  console.log('GitHub:', result.candidateGitHub);
  console.log('Website:', result.candidateWebsite);

  const resumeTextEmpty = `
Name: John Doe
Experience: Software Engineer at Null Co.
`;

  const resultEmpty = await geminiService.analyzeResume(resumeTextEmpty, 'john.pdf');
  console.log('--- Extracted Contact Info (Empty) ---');
  console.log('Email:', resultEmpty.candidateEmail);
  console.log('Phone:', resultEmpty.candidatePhone);
  console.log('LinkedIn:', resultEmpty.candidateLinkedIn);
  console.log('GitHub:', resultEmpty.candidateGitHub);
  console.log('Website:', resultEmpty.candidateWebsite);
}

testExtraction();
