import path from "node:path";
import { BuildInboxAnalysis, SavedScreenshotMetadata, SessionMetadata } from "./types.js";
import { renderGeneratedAnalysis } from "./cleanup.js";

function screenshotList(screenshots: SavedScreenshotMetadata[]): string {
  if (!screenshots.length) {
    return "No screenshots captured.";
  }

  return screenshots
    .map((shot) => {
      const label = `Screenshot ${shot.id}`;
      const near = shot.nearTranscript ? `\n  Near transcript: ${shot.nearTranscript}` : "";
      return `- ${label}: ${shot.filename}\n  URL: ${shot.url}\n  Title: ${shot.title}${near}`;
    })
    .join("\n");
}

export function renderBrief(metadata: SessionMetadata, transcript: string, analysis?: BuildInboxAnalysis): string {
  return `# Build Inbox Brief

Project: ${metadata.projectName}
Mode: ${metadata.mode}
Captured: ${metadata.createdAt}
Source URL: ${metadata.source.url}
Page Title: ${metadata.source.title}

## Summary

${analysis ? analysis.summary : "Not generated. Review transcript and screenshots."}

${analysis ? renderGeneratedAnalysis(analysis) : ""}

## Transcript

${transcript || "No transcript captured."}

## Screenshots

${screenshotList(metadata.screenshots)}

## Notes

`;
}

export function renderCodexPrompt(
  metadata: SessionMetadata,
  sessionPath: string,
  transcript: string,
  analysis?: BuildInboxAnalysis
): string {
  const repoPath = metadata.repoPath;
  const relativeSessionPath = path.relative(repoPath, sessionPath) || sessionPath;

  return `# Task for Codex

You are working in this local repo:

${repoPath}

A Build Inbox capture has been saved here:

${relativeSessionPath}

## Context

Project: ${metadata.projectName}
Mode: ${metadata.mode}
Source URL: ${metadata.source.url}
Page Title: ${metadata.source.title}

${""}

## Generated Task Breakdown

${analysis ? renderGeneratedAnalysis(analysis) : "Not generated. Use the transcript and screenshots directly."}

## My spoken notes

${transcript || "No transcript captured. Review screenshots and metadata."}

## Screenshots

${screenshotList(metadata.screenshots)}

## Instructions

Review the transcript and screenshots.

Please:

1. Identify the concrete coding/product/UX issue being described.
2. Inspect the relevant files in this repo.
3. Propose a short implementation plan before editing.
4. Make the smallest safe change that addresses the issue.
5. Do not redesign unrelated areas.
6. Do not change data models unless clearly necessary.
7. Preserve existing behaviour unless the brief explicitly asks for a change.
8. Run the most relevant checks/tests/lint commands available in the repo.
9. Summarise what changed and any follow-up work.

## Constraints

- Use the existing project conventions.
- Prefer small, reversible changes.
- Do not delete unrelated code.
- Do not introduce new dependencies unless necessary.
- Ask for clarification only if the task cannot be safely inferred from the transcript/screenshots.
`;
}

export function renderIssue(metadata: SessionMetadata, sessionPath: string, transcript: string, analysis?: BuildInboxAnalysis): string {
  return `## Source

Captured with Build Inbox.

Project: ${metadata.projectName}
Mode: ${metadata.mode}
URL: ${metadata.source.url}
Captured: ${metadata.createdAt}

## Generated Summary

${analysis ? renderGeneratedAnalysis(analysis) : "Not generated."}

## Transcript

${transcript || "No transcript captured."}

## Screenshots

${screenshotList(metadata.screenshots)}

## Proposed Task

Review this capture and convert it into a concrete implementation task.

## Local Capture Path

\`\`\`text
${sessionPath}
\`\`\`
`;
}
