// MCP server ที่ wrap bridge agent protocol เป็น native Hermes tools
// ทำหน้าที่เป็น subprocess ที่ Hermes เรียกผ่าน stdio
//
// Tools ที่ expose:
//   mcp_aipass_read_file     — อ่านไฟล์
//   mcp_aipass_list_directory — list directory
//   mcp_aipass_search_files  — grep โปรเจกต์
//   mcp_aipass_edit_file     — แก้ไขไฟล์ (FIND/NEW)
//   mcp_aipass_create_file   — สร้างไฟล์

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = process.env.AIPASS_AGENT_ROOT || process.cwd();

// JSON-RPC 2.0 protocol implementation
class MCPServer {
  constructor() {
    this.tools = [
      {
        name: 'read_file',
        description: 'Read a text file with line numbers. Supports pagination with offset/limit.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or relative to root)' },
            offset: { type: 'number', description: 'Start line (1-indexed, default 1)' },
            limit: { type: 'number', description: 'Max lines (default 2000)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_directory',
        description: 'List files and directories with optional regex filter.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path' },
            pattern: { type: 'string', description: 'Regex filter for names' },
            limit: { type: 'number', description: 'Max entries (default 50)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_files',
        description: 'Search text across project files (grep/ripgrep).',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search text or regex' },
            path: { type: 'string', description: 'Directory to search (default root)' },
            max_results: { type: 'number', description: 'Max matches (default 50)' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'edit_file',
        description: 'Edit a file by replacing exact text. FIND must be unique in the file.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            find: { type: 'string', description: 'Exact text to find (must appear exactly once)' },
            replace: { type: 'string', description: 'Replacement text' },
          },
          required: ['path', 'find', 'replace'],
        },
      },
      {
        name: 'create_file',
        description: 'Create or overwrite a file with content.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'run_command',
       description: 'Run a shell command. Only if --allow-run is enabled via AIPASS_ALLOW_RUN=1.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
          },
          required: ['command'],
        },
      },
    ];
  }

  async handleMessage(msg) {
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'aipass-agent', version: '1.0.0' },
        },
      };
    }

    if (msg.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: this.tools },
      };
    }

    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      try {
        const result = await this.executeTool(name, args);
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: result }] },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    };
  }

  async executeTool(name, args) {
    switch (name) {
      case 'read_file': {
        const fp = this.resolvePath(args.path);
        this.ensureFile(fp);
        const content = readFileSync(fp, 'utf8');
        const lines = content.split('\n');
        const offset = (args.offset || 1) - 1;
        const limit = args.limit || 2000;
        const slice = lines.slice(offset, offset + limit);
        return slice.map((l, i) => `${i + offset + 1}|${l}`).join('\n');
      }

      case 'list_directory': {
        const dp = this.resolvePath(args.path);
        this.ensureDirectory(dp);
        let entries = readdirSync(dp, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.') || args.include_hidden)
          .map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            path: resolve(dp, e.name),
          }));
        if (args.pattern) {
          const re = new RegExp(args.pattern, 'i');
          entries = entries.filter(e => re.test(e.name));
        }
        const limit = args.limit || 50;
        return JSON.stringify({
          path: dp,
          entries: entries.slice(0, limit),
          total: entries.length,
          truncated: entries.length > limit,
        }, null, 2);
      }

      case 'search_files': {
        const searchPath = args.path ? this.resolvePath(args.path) : ROOT;
        this.ensureDirectory(searchPath);
        const maxResults = args.max_results || 50;
        let result;
        try {
          // Try ripgrep first (faster) with larger buffer
          const cmd = `rg -n --no-heading --max-count ${maxResults} ${JSON.stringify(args.pattern)} ${JSON.stringify(searchPath)}`;
          result = execSync(cmd, { 
            encoding: 'utf8', 
            timeout: 10000,
            maxBuffer: 50 * 1024 * 1024, // 50MB
          });
        } catch (err) {
          if (err.status === 1) return 'No matches found'; // rg exit code 1 = no matches
          try {
            // Fallback to grep
            const cmd = `grep -rn --include='*' -m ${maxResults} ${JSON.stringify(args.pattern)} ${JSON.stringify(searchPath)}`;
            result = execSync(cmd, { 
              encoding: 'utf8', 
              timeout: 10000,
              maxBuffer: 50 * 1024 * 1024,
            });
          } catch (grepErr) {
            if (grepErr.status === 1) return 'No matches found';
            throw grepErr;
          }
        }
        return result || 'No matches found';
      }

      case 'edit_file': {
        const fp = this.resolvePath(args.path);
        this.ensureFile(fp);
        const content = readFileSync(fp, 'utf8');
        const idx = content.indexOf(args.find);
        if (idx === -1) throw new Error(`FIND text not found in ${args.path}`);
        const nextIdx = content.indexOf(args.find, idx + 1);
        if (nextIdx !== -1) throw new Error(`FIND text appears multiple times in ${args.path}. Make it unique.`);
        const newContent = content.replace(idx, idx + args.find.length, args.replace);
        writeFileSync(fp, newContent);
        return `✓ Edited ${args.path}`;
      }

      case 'create_file': {
        const fp = this.resolvePath(args.path);
        if (existsSync(fp)) {
          // File exists, treat as overwrite
          writeFileSync(fp, args.content);
          return `✓ Overwritten ${args.path}`;
        }
        // Ensure parent directory exists
        const dir = dirname(fp);
        if (!existsSync(dir)) {
          execSync(`mkdir -p ${JSON.stringify(dir)}`, { encoding: 'utf8' });
        }
        writeFileSync(fp, args.content);
        return `✓ Created ${args.path}`;
      }

      case 'run_command': {
        if (process.env.AIPASS_ALLOW_RUN !== '1') {
          return 'Error: run_command is disabled. Set AIPASS_ALLOW_RUN=1 to enable.';
        }
        const timeout = (args.timeout || 30) * 1000;
        const output = execSync(args.command, {
          encoding: 'utf8',
          timeout,
          cwd: ROOT,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        });
        return output || '(command completed with no output)';
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  resolvePath(p) {
    if (p.startsWith('/') || p.startsWith('~')) {
      return resolve(p);
    }
    return resolve(ROOT, p);
  }

  ensureFile(fp) {
    if (!existsSync(fp)) throw new Error(`File not found: ${fp}`);
    if (!statSync(fp).isFile()) throw new Error(`Not a file: ${fp}`);
  }

  ensureDirectory(dp) {
    if (!existsSync(dp)) throw new Error(`Directory not found: ${dp}`);
    if (!statSync(dp).isDirectory()) throw new Error(`Not a directory: ${dp}`);
  }

  start() {
    let buffer = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg).then(response => {
            if (response) {
              process.stdout.write(JSON.stringify(response) + '\n');
            }
          });
        } catch (err) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${err.message}` },
          }) + '\n');
        }
      }
    });

    // Send initial handshake
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');
  }
}

const server = new MCPServer();
server.start();
