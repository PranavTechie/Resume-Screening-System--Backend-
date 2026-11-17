import { geminiService } from '../services/ai/gemini.service';

async function testRanking() {
  console.log('--- Testing Candidate Ranking Consistency ---');

  const jobTitle = 'Web Developer';
  const jobDescription = `Required Skills: HTML5, CSS3, JavaScript, React / Angular / Vue.js, Git, WordPress/CMS. 
Responsibilities: Integrate back-end databases, servers, and third-party APIs. responsive layouts, performance optimization, debugging, collaboration.`;

  // Candidate 1: Pranav Kadam
  const pranavProfile = `Candidate Name: Pranav Kadam
Target Role: Web Developer
Candidate Detected Technical Skills: web application development, backend/API integration, Git/GitHub, debugging
Candidate Known Missing/Gap Skills: HTML5, CSS3, JavaScript, React, WordPress`;

  const pranavMatch = await geminiService.matchResumeWithJob(pranavProfile, jobTitle, jobDescription);

  console.log('\nPranav Kadam:');
  console.log('Match %:', pranavMatch.matchPercentage);
  console.log('Skills Matched:', pranavMatch.skillsMatchedCount);
  console.log('Strong Matches:', pranavMatch.strongMatches);
  console.log('Skill Gaps:', pranavMatch.skillGaps);
  console.log('Summary:', pranavMatch.matchSummary);
}

testRanking();
