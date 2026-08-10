#!/usr/bin/env node
// Convert 04-final.md (markdown) to the target format expected by the platform.
//
// The delivery ensemble produces markdown, but the platform content model
// expects structured JSON for modules/resources and raw .mmd for diagrams.
// This script bridges that gap.
//
// Surface types:
//   learn        → content/modules/{topic}/<module>.json
//   field-guide  → content/resources/{topic}/<resource>.json
//   visual-guide → diagrams/{topic}.mmd (raw mermaid, extracted from markdown)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Extract raw mermaid code from a markdown file that wraps it in ```mermaid.
 */
function extractMermaid(markdown) {
    const match = markdown.match(/```mermaid\n([\s\S]*?)```/);
    return match ? match[1].trim() : null;
}

/**
 * Convert markdown to a basic learn module JSON structure.
 * This is a best-effort conversion. The markdown is parsed for headings,
 * and sections are created from ## headings. The first # heading becomes
 * the title.
 */
function markdownToModule(markdown, subjectId) {
    const lines = markdown.split('\n');

    // Extract title from first # heading
    let title = subjectId;
    let summary = '';
    let level = 'intermediate';
    const objectives = [];
    const sections = [];
    let currentSection = null;
    let currentParagraphs = [];
    let inMetadata = true;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip empty lines
        if (!line) {
            if (currentParagraphs.length > 0 && currentSection) {
                currentSection.paragraphs.push(currentParagraphs.join(' '));
                currentParagraphs = [];
            }
            continue;
        }

        // H1 = title
        if (line.startsWith('# ') && !line.startsWith('## ')) {
            title = line.replace(/^# /, '');
            inMetadata = false;
            continue;
        }

        // H2 = new section
        if (line.startsWith('## ')) {
            if (currentSection) {
                if (currentParagraphs.length > 0) {
                    currentSection.paragraphs.push(currentParagraphs.join(' '));
                    currentParagraphs = [];
                }
                sections.push(currentSection);
            }
            const sectionTitle = line.replace(/^## /, '');
            currentSection = {
                id: sectionTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                title: sectionTitle,
                paragraphs: [],
            };
            inMetadata = false;
            continue;
        }

        // Level metadata
        if (line.match(/^\*\*Level:\*\*/i)) {
            const lvl = line.replace(/^\*\*Level:\*\*\s*/i, '').toLowerCase();
            if (['beginner', 'intermediate', 'advanced'].includes(lvl)) {
                level = lvl;
            }
            continue;
        }

        // Bullet points after title but before first section = objectives
        if (line.startsWith('- ') && sections.length === 0 && !inMetadata) {
            objectives.push(line.replace(/^- /, ''));
            continue;
        }

        // Regular paragraph text
        if (!inMetadata && currentSection) {
            currentParagraphs.push(line);
        }

        // Capture first substantive paragraph as summary
        if (!summary && !inMetadata && line.length > 60 && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('**')) {
            summary = line.slice(0, 200);
        }
    }

    // Push final section
    if (currentSection) {
        if (currentParagraphs.length > 0) {
            currentSection.paragraphs.push(currentParagraphs.join(' '));
        }
        sections.push(currentSection);
    }

    return {
        id: subjectId,
        title,
        summary: summary || `Learn about ${title}`,
        level,
        reviewCadenceDays: 30,
        lastVerified: new Date().toISOString().split('T')[0],
        providers: ['provider-neutral'],
        estimatedMinutes: 30,
        objectives: objectives.length > 0 ? objectives : ['Understand the key concepts presented in this module.'],
        prerequisites: [],
        sections,
        activity: {
            id: 'apply',
            title: 'Apply what you learned',
            instructions: ['Review the module content and identify one actionable takeaway.'],
            evidence: ['Your documented takeaway with a brief explanation of how you will apply it.'],
        },
        knowledgeCheck: [
            {
                question: `What is the main topic of "${title}"?`,
                options: [title, 'Unrelated concept', 'General knowledge', 'None of the above'],
                correctIndex: 0,
                explanation: `The module focuses on ${title}.`,
            },
        ],
        instructorScript: null,
        sources: [],
    };
}

/**
 * Convert markdown to a basic field guide resource JSON structure.
 */
function markdownToResource(markdown, subjectId) {
    const lines = markdown.split('\n');

    let title = subjectId;
    let summary = '';
    const sections = [];
    let currentSection = null;
    let currentParagraphs = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (currentParagraphs.length > 0 && currentSection) {
                currentSection.paragraphs.push(currentParagraphs.join(' '));
                currentParagraphs = [];
            }
            continue;
        }

        if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
            title = trimmed.replace(/^# /, '');
            continue;
        }

        if (trimmed.startsWith('## ')) {
            if (currentSection) {
                if (currentParagraphs.length > 0) {
                    currentSection.paragraphs.push(currentParagraphs.join(' '));
                    currentParagraphs = [];
                }
                sections.push(currentSection);
            }
            currentSection = {
                id: trimmed.replace(/^## /, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                title: trimmed.replace(/^## /, ''),
                paragraphs: [],
            };
            continue;
        }

        if (currentSection && !trimmed.startsWith('**Level') && !trimmed.startsWith('**Audience')) {
            currentParagraphs.push(trimmed);
        }

        if (!summary && trimmed.length > 60 && !trimmed.startsWith('#') && !trimmed.startsWith('**')) {
            summary = trimmed.slice(0, 200);
        }
    }

    if (currentSection) {
        if (currentParagraphs.length > 0) {
            currentSection.paragraphs.push(currentParagraphs.join(' '));
        }
        sections.push(currentSection);
    }

    return {
        id: subjectId,
        slug: subjectId,
        title,
        summary: summary || `Reference for ${title}`,
        category: 'field-guide',
        format: 'reference',
        audience: ['practitioner'],
        level: 'intermediate',
        providers: ['provider-neutral'],
        prerequisites: [],
        owner: 'orchard',
        reviewCadenceDays: 30,
        lastVerified: new Date().toISOString().split('T')[0],
        tags: [],
        sections,
        sources: [],
    };
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i += 1; }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.input || !args.output || !args.surface || !args.subject) {
        console.error('usage: convert-delivery-format.mjs --input <04-final.md> --output <target-path> --surface <learn|field-guide|visual-guide> --subject <subject-id>');
        process.exit(2);
    }

    const inputPath = resolve(args.input);
    const outputPath = resolve(args.output);
    const surface = args.surface;
    const subjectId = args.subject;

    if (!existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const markdown = readFileSync(inputPath, 'utf-8');

    let outputContent;
    switch (surface) {
        case 'visual-guide': {
            const mermaid = extractMermaid(markdown);
            if (!mermaid) {
                console.error('No mermaid code block found in markdown. Is this a visual guide?');
                process.exit(1);
            }
            outputContent = mermaid;
            break;
        }
        case 'learn': {
            const module = markdownToModule(markdown, subjectId);
            outputContent = JSON.stringify(module, null, 2);
            break;
        }
        case 'field-guide': {
            const resource = markdownToResource(markdown, subjectId);
            outputContent = JSON.stringify(resource, null, 2);
            break;
        }
        default:
            console.error(`Unknown surface: ${surface}. Expected learn, field-guide, or visual-guide.`);
            process.exit(1);
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, outputContent + '\n', 'utf-8');
    console.log(`Converted ${surface} content: ${inputPath} → ${outputPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
