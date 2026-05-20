#!/usr/bin/env node
/**
 * Patches tree-sitter-dart to use NAPI bindings compatible with tree-sitter 0.22+
 *
 * tree-sitter-dart v1.0.0 ships with NAN-style bindings that are incompatible
 * with tree-sitter 0.22+ which expects NAPI-style bindings with type-tagged
 * externals. This script rewrites the binding files and rebuilds.
 */
const { writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

const DART_DIR = join(__dirname, '..', 'node_modules', 'tree-sitter-dart');

if (!existsSync(DART_DIR)) {
  // tree-sitter-dart not installed, skip
  process.exit(0);
}

// Check if already patched (look for NAPI-style binding)
const bindingPath = join(DART_DIR, 'bindings', 'node', 'binding.cc');
const { readFileSync } = require('fs');
try {
  const existing = readFileSync(bindingPath, 'utf8');
  if (existing.includes('napi.h')) {
    // Already patched, check if build exists
    const buildPath = join(DART_DIR, 'build', 'Release', 'tree_sitter_dart_binding.node');
    if (existsSync(buildPath)) {
      console.log('tree-sitter-dart: already patched and built.');
      process.exit(0);
    }
    // Patched but not built, fall through to rebuild
  }
} catch {
  // Can't read, continue with patch
}

console.log('Patching tree-sitter-dart for NAPI compatibility...');

// Write NAPI-compatible binding.cc
const bindingCC = `#include <napi.h>

typedef struct TSLanguage TSLanguage;

extern "C" TSLanguage *tree_sitter_dart();

// "tree-sitter", "language" hashed with BLAKE2
const napi_type_tag LANGUAGE_TYPE_TAG = {
    0x8AF2E5212AD58ABF, 0xD5006CAD83ABBA16
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports["name"] = Napi::String::New(env, "dart");
    auto language = Napi::External<TSLanguage>::New(env, tree_sitter_dart());
    language.TypeTag(&LANGUAGE_TYPE_TAG);
    exports["language"] = language;
    return exports;
}

NODE_API_MODULE(tree_sitter_dart_binding, Init)
`;
writeFileSync(bindingPath, bindingCC);

// Write NAPI-compatible binding.gyp
const bindingGyp = `{
  "targets": [
    {
      "target_name": "tree_sitter_dart_binding",
      "dependencies": [
        "<!(node -p \\"require('node-addon-api').targets\\"):node_addon_api_except"
      ],
      "include_dirs": [
        "src"
      ],
      "sources": [
        "src/parser.c",
        "bindings/node/binding.cc",
        "src/scanner.c"
      ],
      "conditions": [
        ["OS!='win'", {
          "cflags_c": [
            "-std=c99"
          ]
        }, {
          "cflags_c": [
            "/std:c11",
            "/utf-8"
          ]
        }]
      ]
    }
  ]
}
`;
writeFileSync(join(DART_DIR, 'binding.gyp'), bindingGyp);

// Rebuild native module
try {
  execSync('npx node-gyp rebuild', {
    cwd: DART_DIR,
    stdio: 'pipe',
    timeout: 120000,
  });
  console.log('tree-sitter-dart: patched and rebuilt successfully.');
} catch (error) {
  console.error('Warning: Failed to rebuild tree-sitter-dart native module.');
  console.error('Dart language support may not work.');
  if (process.env.DEBUG) {
    console.error(error.stderr?.toString());
  }
}
