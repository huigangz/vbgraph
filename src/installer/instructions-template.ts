/**
 * Agent-instructions template — the markdown body each agent target
 * writes into its conventional instructions file (CLAUDE.md /
 * AGENTS.md / vbgraph.mdc / etc.).
 *
 * The body content is identical across agents because the vbgraph
 * usage advice is agent-agnostic — only the destination filename and
 * any optional frontmatter (Cursor `.mdc`) varies per target.
 *
 * The legacy `claude-md-template.ts` re-exports these names for
 * backwards compatibility with downstream importers.
 */

/** Markers used by the marker-based section replacement. */
export const VBGRAPH_SECTION_START = '<!-- VBGRAPH_START -->';
export const VBGRAPH_SECTION_END = '<!-- VBGRAPH_END -->';

/**
 * The full marker-delimited block written into each agent's
 * instructions file. Includes the start/end markers so the section
 * can be detected and replaced on re-install.
 */
export const INSTRUCTIONS_TEMPLATE = `${VBGRAPH_SECTION_START}
## VBGraph

This project has a VBGraph MCP server (\`vbgraph_*\` tools) configured. VBGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer vbgraph over native search

Use vbgraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "How does X work? / trace X / explain a system / architecture" | \`vbgraph_explore\` (seed with symbol names) |
| "Where is X defined?" / "Find symbol named X" | \`vbgraph_search\` (pass \`tag\` to narrow by framework role — e.g. \`tag: 'spring:service'\`, \`tag: 'react:hook'\`, \`tag: 'route-handler'\`) |
| "What calls function Y?" | \`vbgraph_callers\` (entries end with a confidence tier — \`[compiler]\` > \`[scope-resolved]\` > \`[syntactic]\` > \`[inferred]\`) |
| "What does Y call?" | \`vbgraph_callees\` (same tier annotation) |
| "What would break if I changed Z?" | \`vbgraph_impact\` |
| "Show me Y's signature / source / docstring" | \`vbgraph_node\` |
| "Give me focused context for a task/area" | \`vbgraph_context\` |
| "What files exist under path/" | \`vbgraph_files\` |
| "Is the index healthy?" | \`vbgraph_status\` |

### Rules of thumb

- **\`vbgraph_explore\` is the workhorse for understanding questions** ("how does X work", "trace…", "explain the Y system"). Feed it the key symbol/file names and read its output (line-numbered source from many files in one call). If the question names nothing concrete, do one quick \`vbgraph_search\`/\`vbgraph_context\` to surface the names, then explore with them. Fill gaps with \`vbgraph_node\`/Read — don't grep-and-read your way through; that's the loop explore replaces.
- **Delegating exploration to a subagent?** Tell it to call \`vbgraph_explore\` first and trust the result. A generic "explore"-style agent defaults to grep+Read and treats vbgraph as just a search index, throwing away the token savings.
- **Trust vbgraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. \`vbgraph_search\` is faster and returns kind + location + signature in one call.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If \`.vbgraph/\` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have VBGraph initialized. Want me to run \`vbgraph init -i\` to build the index?"*
${VBGRAPH_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
