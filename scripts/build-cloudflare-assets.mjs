import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.');
const output = resolve('.cloudflare-assets');
const canonicalExerciseSource = resolve(root, 'data', 'exercises.v1.json');
const files = [
  'index.html', 'recovery.html', '_headers', 'app.js', 'storage.js', 'exercise-service.js', 'program-service.js',
  'import-service.js', 'document-extractor.js', 'local-import-parser.js',
  'import-provider.js', 'openai-import-parser.js', 'youtube-service.js', 'styles.css',
  'auth-service.js', 'sync-service.js', 'manifest.webmanifest', 'sw.js'
];
const directories = ['icons', 'images'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(files.map(file => cp(resolve(root, file), resolve(output, file))));
await Promise.all(directories.map(directory => cp(resolve(root, directory), resolve(output, directory), { recursive: true })));
await mkdir(resolve(output, 'data'), { recursive: true });
await Promise.all([
  cp(canonicalExerciseSource, resolve(output, 'data', 'exercises.v1.json')),
  cp(resolve(root, 'data', 'public-programs.js'), resolve(output, 'data', 'public-programs.js'))
]);
console.log('Cloudflare static assets prepared.');
