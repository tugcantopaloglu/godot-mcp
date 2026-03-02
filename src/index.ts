#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { createConnection, Socket } from 'net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import {
  PARAMETER_MAPPINGS,
  REVERSE_PARAMETER_MAPPINGS,
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  createErrorResponse,
  isGodot44OrLater,
  type OperationParams,
} from './utils.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for a TCP connection to the running game
 */
interface GameConnection {
  socket: Socket | null;
  connected: boolean;
  responseBuffer: string;
  pendingResolve: ((value: any) => void) | null;
  projectPath: string | null;
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private interactionScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;
  private gameConnection: GameConnection = {
    socket: null,
    connected: false,
    responseBuffer: '',
    pendingResolve: null,
    projectPath: null,
  };
  private lastErrorIndex: number = 0;
  private lastLogIndex: number = 0;
  private readonly INTERACTION_PORT = 9090;
  private readonly AUTOLOAD_NAME = 'McpInteractionServer';

  constructor(config?: GodotServerConfig) {
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    this.interactionScriptPath = join(__dirname, 'scripts', 'mcp_interaction_server.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }


  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      // Using execFileAsync with argument array to prevent command injection
      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Inject the interaction server script into the Godot project
   */
  private injectInteractionServer(projectPath: string): void {
    const projectFile = join(projectPath, 'project.godot');
    const destScript = join(projectPath, 'mcp_interaction_server.gd');

    // Copy the interaction script into the project
    copyFileSync(this.interactionScriptPath, destScript);
    this.logDebug(`Copied interaction server script to ${destScript}`);

    // Add autoload entry to project.godot
    let content = readFileSync(projectFile, 'utf8');

    // Check if already injected
    if (content.includes(this.AUTOLOAD_NAME)) {
      this.logDebug('Interaction server autoload already present');
      return;
    }

    const autoloadLine = `${this.AUTOLOAD_NAME}="*res://mcp_interaction_server.gd"`;

    if (content.includes('[autoload]')) {
      // Add after existing [autoload] section header
      content = content.replace('[autoload]', `[autoload]\n\n${autoloadLine}`);
    } else {
      // Add new [autoload] section at end
      content += `\n[autoload]\n\n${autoloadLine}\n`;
    }

    writeFileSync(projectFile, content, 'utf8');
    this.logDebug(`Injected ${this.AUTOLOAD_NAME} autoload into project.godot`);
  }

  /**
   * Remove the interaction server script and autoload from the project
   */
  private removeInteractionServer(projectPath: string): void {
    const projectFile = join(projectPath, 'project.godot');
    const destScript = join(projectPath, 'mcp_interaction_server.gd');

    // Remove autoload line from project.godot
    if (existsSync(projectFile)) {
      let content = readFileSync(projectFile, 'utf8');
      // Remove the autoload line (and any surrounding blank line)
      const autoloadLine = `${this.AUTOLOAD_NAME}="*res://mcp_interaction_server.gd"`;
      content = content.replace(new RegExp(`\\n?${autoloadLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`), '\n');
      writeFileSync(projectFile, content, 'utf8');
      this.logDebug('Removed interaction server autoload from project.godot');
    }

    // Delete the script file
    if (existsSync(destScript)) {
      unlinkSync(destScript);
      this.logDebug('Deleted interaction server script from project');
    }

    // Also clean up the .uid file if Godot created one
    const uidFile = destScript + '.uid';
    if (existsSync(uidFile)) {
      unlinkSync(uidFile);
      this.logDebug('Deleted interaction server .uid file');
    }
  }

  /**
   * Connect to the game's TCP interaction server with retries
   */
  private async connectToGame(projectPath: string): Promise<void> {
    this.gameConnection.projectPath = projectPath;

    // Initial delay to let the game start up
    await new Promise(resolve => setTimeout(resolve, 2000));

    const maxAttempts = 10;
    const retryDelay = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.activeProcess) {
        this.logDebug('Game process no longer running, aborting connection');
        return;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: this.INTERACTION_PORT }, () => {
            this.gameConnection.socket = socket;
            this.gameConnection.connected = true;
            this.gameConnection.responseBuffer = '';
            this.logDebug(`Connected to game interaction server (attempt ${attempt})`);
            console.error(`[SERVER] Connected to game interaction server on port ${this.INTERACTION_PORT}`);

            socket.on('data', (data: Buffer) => {
              this.gameConnection.responseBuffer += data.toString();
              // Process complete lines
              while (this.gameConnection.responseBuffer.includes('\n')) {
                const newlinePos = this.gameConnection.responseBuffer.indexOf('\n');
                const line = this.gameConnection.responseBuffer.substring(0, newlinePos).trim();
                this.gameConnection.responseBuffer = this.gameConnection.responseBuffer.substring(newlinePos + 1);
                if (line.length > 0 && this.gameConnection.pendingResolve) {
                  try {
                    const parsed = JSON.parse(line);
                    const resolver = this.gameConnection.pendingResolve;
                    this.gameConnection.pendingResolve = null;
                    resolver(parsed);
                  } catch (e) {
                    this.logDebug(`Failed to parse game response: ${line}`);
                  }
                }
              }
            });

            socket.on('close', () => {
              this.logDebug('Game interaction connection closed');
              this.gameConnection.connected = false;
              this.gameConnection.socket = null;
              if (this.gameConnection.pendingResolve) {
                this.gameConnection.pendingResolve({ error: 'Connection closed' });
                this.gameConnection.pendingResolve = null;
              }
            });

            socket.on('error', (err: Error) => {
              this.logDebug(`Game interaction socket error: ${err.message}`);
            });

            resolve();
          });

          socket.on('error', (err: Error) => {
            reject(err);
          });
        });

        // Successfully connected
        return;
      } catch (err) {
        this.logDebug(`Connection attempt ${attempt}/${maxAttempts} failed, retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    console.error(`[SERVER] Failed to connect to game interaction server after ${maxAttempts} attempts`);
  }

  /**
   * Disconnect from the game interaction server
   */
  private disconnectFromGame(): void {
    if (this.gameConnection.socket) {
      this.gameConnection.socket.destroy();
      this.gameConnection.socket = null;
    }
    this.gameConnection.connected = false;
    this.gameConnection.responseBuffer = '';
    if (this.gameConnection.pendingResolve) {
      this.gameConnection.pendingResolve({ error: 'Disconnected' });
      this.gameConnection.pendingResolve = null;
    }
  }

  /**
   * Send a command to the running game and wait for a response
   */
  private async sendGameCommand(command: string, params: Record<string, any> = {}, timeoutMs: number = 10000): Promise<any> {
    if (!this.gameConnection.connected || !this.gameConnection.socket) {
      throw new Error('Not connected to game interaction server. Is the game running?');
    }

    const payload = JSON.stringify({ command, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.gameConnection.pendingResolve = null;
        reject(new Error(`Game command '${command}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.gameConnection.pendingResolve = (response: any) => {
        clearTimeout(timeout);
        resolve(response);
      };

      this.gameConnection.socket!.write(payload);
    });
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    this.disconnectFromGame();
    if (this.gameConnection.projectPath) {
      this.removeInteractionServer(this.gameConnection.projectPath);
      this.gameConnection.projectPath = null;
    }
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    await this.server.close();
  }

  private async gameCommand(
    name: string,
    args: any,
    argsFn: (a: any) => Record<string, any>,
    timeoutMs?: number
  ): Promise<any> {
    if (!this.activeProcess) return createErrorResponse('No active Godot process. Use run_project first.');
    if (!this.gameConnection.connected) return createErrorResponse('Not connected to game interaction server.');
    args = normalizeParameters(args || {});
    try {
      const response = await this.sendGameCommand(name, argsFn(args), timeoutMs);
      if (response.error) return createErrorResponse(`${name} failed: ${response.error}`);
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    } catch (error: any) {
      return createErrorResponse(`${name} failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async headlessOp(
    operation: string,
    args: any,
    argsFn: (a: any) => { projectPath: string; params: OperationParams }
  ): Promise<any> {
    args = normalizeParameters(args || {});
    const { projectPath, params } = argsFn(args);

    if (!projectPath) return createErrorResponse('projectPath is required.');
    if (!validatePath(projectPath)) return createErrorResponse('Invalid path.');

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${projectPath}`);

    try {
      const { stdout, stderr } = await this.executeOperation(operation, params, projectPath);
      if (stderr && stderr.includes('Failed to')) return createErrorResponse(`${operation} failed: ${stderr}`);
      return { content: [{ type: 'text', text: `${operation} succeeded.\n\nOutput: ${stdout}` }] };
    } catch (error: any) {
      return createErrorResponse(`${operation} failed: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Build argument array for execFile to prevent command injection
      // Using execFile with argument arrays avoids shell interpretation entirely
      const args = [
        '--headless',
        '--path',
        projectPath,  // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson,  // Safe: passed as argument, not interpreted by shell
      ];

      
      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.godotPath!, args);

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Scene file path (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Scene file path (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Scene file path (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references by resaving resources (4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'game_screenshot',
          description: 'Screenshot the running game (returns base64 PNG)',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'game_click',
          description: 'Click at a position in the running Godot game window',
          inputSchema: {
            type: 'object',
            properties: {
              x: {
                type: 'number',
                description: 'X coordinate to click',
              },
              y: {
                type: 'number',
                description: 'Y coordinate to click',
              },
              button: {
                type: 'number',
                description: 'Mouse button (1=left, 2=right, 3=middle). Default: 1',
              },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'game_key_press',
          description: 'Send a key press or input action to the running game',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Key name (e.g. "W", "Space", "Escape", "Enter")',
              },
              action: {
                type: 'string',
                description: 'Godot input action name (e.g. "move_forward", "ui_accept")',
              },
              pressed: {
                type: 'boolean',
                description: 'Press (true) or release (false). Default: true (auto-release)',
              },
            },
            required: [],
          },
        },
        {
          name: 'game_mouse_move',
          description: 'Move the mouse in the running Godot game',
          inputSchema: {
            type: 'object',
            properties: {
              x: {
                type: 'number',
                description: 'Absolute X position',
              },
              y: {
                type: 'number',
                description: 'Absolute Y position',
              },
              relative_x: {
                type: 'number',
                description: 'Relative X movement',
              },
              relative_y: {
                type: 'number',
                description: 'Relative Y movement',
              },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'game_get_ui',
          description: 'Get visible UI elements from the running game',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'game_get_scene_tree',
          description: 'Get scene tree structure of the running game',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
{
          name: 'game_eval',
          description: 'Execute GDScript in the running game. Use "return" for values.',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'GDScript code to execute. Use "return" to return values.',
              },
            },
            required: ['code'],
          },
        },
        {
          name: 'game_get_property',
          description: 'Get a property value from any node in the running game by its path',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node (e.g., "/root/Player", "/root/Main/Enemy")',
              },
              property: {
                type: 'string',
                description: 'Property name to get (e.g., "position", "health", "visible")',
              },
            },
            required: ['nodePath', 'property'],
          },
        },
        {
          name: 'game_set_property',
          description: 'Set a property on a node in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node',
              },
              property: {
                type: 'string',
                description: 'Property name to set',
              },
              value: {
                description: 'Value to set. Use objects for vectors/colors',
              },
              typeHint: {
                type: 'string',
                description: 'Optional type hint: "Vector2", "Vector3", "Color"',
              },
            },
            required: ['nodePath', 'property', 'value'],
          },
        },
        {
          name: 'game_call_method',
          description: 'Call a method on any node in the running game with optional arguments',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node',
              },
              method: {
                type: 'string',
                description: 'Method name to call',
              },
              args: {
                type: 'array',
                description: 'Optional array of arguments to pass to the method',
              },
            },
            required: ['nodePath', 'method'],
          },
        },
        {
          name: 'game_get_node_info',
          description: 'Get node info: class, properties, signals, methods, children',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node (e.g., "/root/Player")',
              },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'game_instantiate_scene',
          description: 'Load a PackedScene and add it as a child of a node in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              scenePath: {
                type: 'string',
                description: 'Resource path to the scene (e.g., "res://scenes/enemy.tscn")',
              },
              parentPath: {
                type: 'string',
                description: 'Path to the parent node. Default: "/root"',
              },
            },
            required: ['scenePath'],
          },
        },
        {
          name: 'game_remove_node',
          description: 'Remove and free a node from the running game\'s scene tree',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: {
                type: 'string',
                description: 'Path to the node to remove',
              },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'game_change_scene',
          description: 'Switch to a different scene file in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              scenePath: {
                type: 'string',
                description: 'Resource path to the scene (e.g., "res://scenes/levels/level2.tscn")',
              },
            },
            required: ['scenePath'],
          },
        },
        {
          name: 'game_pause',
          description: 'Pause or unpause the running game',
          inputSchema: {
            type: 'object',
            properties: {
              paused: {
                type: 'boolean',
                description: 'True to pause, false to unpause. Default: true',
              },
            },
            required: [],
          },
        },
        {
          name: 'game_performance',
          description: 'Get performance metrics (FPS, memory, draw calls)',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'game_wait',
          description: 'Wait N frames in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              frames: {
                type: 'number',
                description: 'Number of frames to wait. Default: 1',
              },
            },
            required: [],
          },
        },
{
          name: 'read_scene',
          description: 'Read scene file as JSON node tree (headless)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Scene file path (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'modify_scene_node',
          description: 'Modify node properties in a scene file (headless)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Scene file path (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the node within the scene (e.g., "root/Player/Sprite2D")',
              },
              properties: {
                type: 'object',
                description: 'Properties to set on the node as key-value pairs',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'properties'],
          },
        },
        {
          name: 'remove_scene_node',
          description: 'Remove a node from a scene file (headless)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              scenePath: {
                type: 'string',
                description: 'Scene file path (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the node to remove (e.g., "root/Player/OldNode")',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
{
          name: 'read_project_settings',
          description: 'Read project.godot as structured JSON',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'modify_project_settings',
          description: 'Modify a project.godot setting',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              section: {
                type: 'string',
                description: 'Section in project.godot (e.g., "application", "display", "rendering")',
              },
              key: {
                type: 'string',
                description: 'Setting key (e.g., "run/main_scene", "window/size/viewport_width")',
              },
              value: {
                type: 'string',
                description: 'Value to set (as a string, will be written as-is)',
              },
            },
            required: ['projectPath', 'section', 'key', 'value'],
          },
        },
        {
          name: 'list_project_files',
          description: 'List project files, optionally filtered by extension',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Godot project path',
              },
              extensions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional file extensions to filter by (e.g., [".gd", ".tscn"]). Include the dot.',
              },
              subdirectory: {
                type: 'string',
                description: 'Optional subdirectory to search in (e.g., "scripts/player")',
              },
            },
            required: ['projectPath'],
          },
        },
{
          name: 'game_connect_signal',
          description: 'Connect a signal from one node to a method on another node in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the source node that emits the signal' },
              signalName: { type: 'string', description: 'Name of the signal to connect' },
              targetPath: { type: 'string', description: 'Path to the target node that receives the signal' },
              method: { type: 'string', description: 'Method name to call on the target node' },
            },
            required: ['nodePath', 'signalName', 'targetPath', 'method'],
          },
        },
        {
          name: 'game_disconnect_signal',
          description: 'Disconnect a signal connection in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the source node' },
              signalName: { type: 'string', description: 'Name of the signal' },
              targetPath: { type: 'string', description: 'Path to the target node' },
              method: { type: 'string', description: 'Method name on the target' },
            },
            required: ['nodePath', 'signalName', 'targetPath', 'method'],
          },
        },
        {
          name: 'game_emit_signal',
          description: 'Emit a signal on a node in the running game, optionally with arguments',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the node' },
              signalName: { type: 'string', description: 'Name of the signal to emit' },
              args: { type: 'array', description: 'Optional arguments to pass with the signal' },
            },
            required: ['nodePath', 'signalName'],
          },
        },
        {
          name: 'game_play_animation',
          description: 'Control an AnimationPlayer node: play, stop, pause, or list animations',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the AnimationPlayer node' },
              action: { type: 'string', description: 'Action: "play", "stop", "pause", or "get_list"' },
              animation: { type: 'string', description: 'Animation name (required for "play" action)' },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'game_tween_property',
          description: 'Tween a node property in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the node' },
              property: { type: 'string', description: 'Property to tween (e.g., "position", "modulate")' },
              finalValue: { description: 'Target value. Use {x,y} for Vector2, {x,y,z} for Vector3, {r,g,b,a} for Color' },
              duration: { type: 'number', description: 'Duration in seconds. Default: 1.0' },
              transType: { type: 'number', description: 'Tween.TransitionType enum value. Default: 0 (LINEAR)' },
              easeType: { type: 'number', description: 'Tween.EaseType enum value. Default: 2 (IN_OUT)' },
            },
            required: ['nodePath', 'property', 'finalValue'],
          },
        },
        {
          name: 'game_get_nodes_in_group',
          description: 'Get all nodes belonging to a specific group in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              group: { type: 'string', description: 'Group name (e.g., "enemies", "player", "checkpoints")' },
            },
            required: ['group'],
          },
        },
        {
          name: 'game_find_nodes_by_class',
          description: 'Find all nodes of a specific class type in the running game',
          inputSchema: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Class name to search for (e.g., "CharacterBody3D", "Light3D")' },
              rootPath: { type: 'string', description: 'Root node path to start searching from. Default: "/root"' },
            },
            required: ['className'],
          },
        },
        {
          name: 'game_reparent_node',
          description: 'Move a node to a new parent in the running game\'s scene tree',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the node to move' },
              newParentPath: { type: 'string', description: 'Path to the new parent node' },
              keepGlobalTransform: { type: 'boolean', description: 'Whether to keep the global transform. Default: true' },
            },
            required: ['nodePath', 'newParentPath'],
          },
        },
{
          name: 'attach_script',
          description: 'Attach a GDScript to a scene node (headless)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              scenePath: { type: 'string', description: 'Scene file path (relative to project)' },
              nodePath: { type: 'string', description: 'Path to the node within the scene (e.g., "root/Player")' },
              scriptPath: { type: 'string', description: 'Path to the .gd script file (relative to project)' },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
          },
        },
        {
          name: 'create_resource',
          description: 'Create a .tres resource file (headless)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              resourceType: { type: 'string', description: 'Godot class name (e.g., "StandardMaterial3D", "Theme", "Environment")' },
              resourcePath: { type: 'string', description: 'Where to save the .tres file (relative to project)' },
              properties: { type: 'object', description: 'Optional properties to set on the resource' },
            },
            required: ['projectPath', 'resourceType', 'resourcePath'],
          },
        },
        // File I/O tools
        {
          name: 'read_file',
          description: 'Read a text file from a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              filePath: { type: 'string', description: 'File path relative to project root' },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'write_file',
          description: 'Create or overwrite a text file in a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              filePath: { type: 'string', description: 'File path relative to project root' },
              content: { type: 'string', description: 'File content to write' },
            },
            required: ['projectPath', 'filePath', 'content'],
          },
        },
        {
          name: 'delete_file',
          description: 'Delete a file from a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              filePath: { type: 'string', description: 'File path relative to project root' },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'create_directory',
          description: 'Create a directory inside a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              directoryPath: { type: 'string', description: 'Directory path relative to project root' },
            },
            required: ['projectPath', 'directoryPath'],
          },
        },
        // Error/Log capture tools
        {
          name: 'game_get_errors',
          description: 'Get new push_error/push_warning messages since last call',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'game_get_logs',
          description: 'Get new print output from the running game since last call',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        // Enhanced input tools
        {
          name: 'game_key_hold',
          description: 'Hold a key down without auto-releasing',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Key name (e.g. "W", "Space", "Shift")' },
              action: { type: 'string', description: 'Godot input action name (e.g. "move_forward")' },
            },
            required: [],
          },
        },
        {
          name: 'game_key_release',
          description: 'Release a previously held key',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Key name to release' },
              action: { type: 'string', description: 'Godot input action name to release' },
            },
            required: [],
          },
        },
        {
          name: 'game_scroll',
          description: 'Send mouse scroll wheel event at position',
          inputSchema: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'X position for scroll event' },
              y: { type: 'number', description: 'Y position for scroll event' },
              direction: { type: 'string', description: '"up", "down", "left", or "right". Default: "up"' },
              amount: { type: 'number', description: 'Scroll amount (clicks). Default: 1' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'game_mouse_drag',
          description: 'Drag mouse between two points over N frames',
          inputSchema: {
            type: 'object',
            properties: {
              fromX: { type: 'number', description: 'Start X coordinate' },
              fromY: { type: 'number', description: 'Start Y coordinate' },
              toX: { type: 'number', description: 'End X coordinate' },
              toY: { type: 'number', description: 'End Y coordinate' },
              button: { type: 'number', description: 'Mouse button (1=left). Default: 1' },
              steps: { type: 'number', description: 'Number of frames for the drag. Default: 10' },
            },
            required: ['fromX', 'fromY', 'toX', 'toY'],
          },
        },
        {
          name: 'game_gamepad',
          description: 'Send gamepad button or axis input event',
          inputSchema: {
            type: 'object',
            properties: {
              type: { type: 'string', description: '"button" or "axis"' },
              index: { type: 'number', description: 'Button or axis index' },
              value: { type: 'number', description: 'Value: 0/1 for buttons, -1.0 to 1.0 for axes' },
              device: { type: 'number', description: 'Gamepad device index. Default: 0' },
            },
            required: ['type', 'index', 'value'],
          },
        },
        // Project management tools
        {
          name: 'create_project',
          description: 'Create a new Godot project from scratch',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Directory where the project will be created' },
              projectName: { type: 'string', description: 'Name of the project' },
            },
            required: ['projectPath', 'projectName'],
          },
        },
        {
          name: 'manage_autoloads',
          description: 'Add, remove, or list autoloads in a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              action: { type: 'string', description: '"list", "add", or "remove"' },
              name: { type: 'string', description: 'Autoload name (required for add/remove)' },
              path: { type: 'string', description: 'Script/scene path (required for add, e.g. "res://globals.gd")' },
            },
            required: ['projectPath', 'action'],
          },
        },
        {
          name: 'manage_input_map',
          description: 'Add, remove, or list input actions and bindings',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              action: { type: 'string', description: '"list", "add", or "remove"' },
              actionName: { type: 'string', description: 'Input action name (required for add/remove)' },
              key: { type: 'string', description: 'Key to bind (for add, e.g. "W", "Space")' },
              deadzone: { type: 'number', description: 'Deadzone for the action. Default: 0.5' },
            },
            required: ['projectPath', 'action'],
          },
        },
        {
          name: 'manage_export_presets',
          description: 'Create or modify export preset configuration',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              action: { type: 'string', description: '"list", "add", or "remove"' },
              name: { type: 'string', description: 'Preset name (required for add/remove)' },
              platform: { type: 'string', description: 'Platform (for add, e.g. "Windows Desktop", "Linux", "Web")' },
              runnable: { type: 'boolean', description: 'Whether this preset is runnable. Default: false' },
            },
            required: ['projectPath', 'action'],
          },
        },
        // Advanced runtime tools
        {
          name: 'game_get_camera',
          description: 'Get active camera position, rotation, and size',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'game_set_camera',
          description: 'Move or rotate the active camera',
          inputSchema: {
            type: 'object',
            properties: {
              position: { type: 'object', description: '{x,y} or {x,y,z} for camera position' },
              rotation: { type: 'object', description: '{x,y,z} rotation in degrees' },
              zoom: { type: 'object', description: '{x,y} zoom for Camera2D' },
              fov: { type: 'number', description: 'Field of view for Camera3D' },
            },
            required: [],
          },
        },
        {
          name: 'game_raycast',
          description: 'Cast a ray and return collision results',
          inputSchema: {
            type: 'object',
            properties: {
              from: { type: 'object', description: 'Start point {x,y} or {x,y,z}' },
              to: { type: 'object', description: 'End point {x,y} or {x,y,z}' },
              collisionMask: { type: 'number', description: 'Collision mask. Default: 0xFFFFFFFF' },
            },
            required: ['from', 'to'],
          },
        },
        {
          name: 'game_get_audio',
          description: 'Get audio bus layout and playing streams',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'game_spawn_node',
          description: 'Create a new node of any type at runtime',
          inputSchema: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Node class name (e.g. "Sprite2D", "CharacterBody3D")' },
              name: { type: 'string', description: 'Name for the new node. Default: auto-generated' },
              parentPath: { type: 'string', description: 'Parent node path. Default: "/root"' },
              properties: { type: 'object', description: 'Properties to set on the new node' },
            },
            required: ['type'],
          },
        },
        // Shader, audio, navigation, tilemap, collision, environment tools
        {
          name: 'game_set_shader_param',
          description: 'Set a shader parameter on a node\'s material',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the node with a ShaderMaterial' },
              paramName: { type: 'string', description: 'Shader parameter name' },
              value: { description: 'Value to set (number, object, array, etc.)' },
              typeHint: { type: 'string', description: 'Optional type hint (e.g. "Color", "Vector2")' },
            },
            required: ['nodePath', 'paramName', 'value'],
          },
        },
        {
          name: 'game_audio_play',
          description: 'Play, stop, or pause an AudioStreamPlayer node',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to AudioStreamPlayer/2D/3D node' },
              action: { type: 'string', description: 'Action: play, stop, pause, resume' },
              stream: { type: 'string', description: 'Optional res:// path to load a new stream' },
              volume: { type: 'number', description: 'Volume (linear 0-1)' },
              pitch: { type: 'number', description: 'Pitch scale' },
              bus: { type: 'string', description: 'Audio bus name' },
              fromPosition: { type: 'number', description: 'Start position in seconds' },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'game_audio_bus',
          description: 'Set volume, mute, or solo on an audio bus',
          inputSchema: {
            type: 'object',
            properties: {
              busName: { type: 'string', description: 'Bus name. Default: "Master"' },
              volume: { type: 'number', description: 'Volume (linear 0-1)' },
              mute: { type: 'boolean', description: 'Mute the bus' },
              solo: { type: 'boolean', description: 'Solo the bus' },
            },
            required: [],
          },
        },
        {
          name: 'game_navigate_path',
          description: 'Query a navigation path between two points',
          inputSchema: {
            type: 'object',
            properties: {
              start: { type: 'object', description: 'Start point {x,y} or {x,y,z}' },
              end: { type: 'object', description: 'End point {x,y} or {x,y,z}' },
              optimize: { type: 'boolean', description: 'Use string-pulling optimization. Default: true' },
            },
            required: ['start', 'end'],
          },
        },
        {
          name: 'game_tilemap',
          description: 'Get or set cells in a TileMapLayer node',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to TileMapLayer node' },
              action: { type: 'string', description: 'Action: set_cells, get_cell, erase_cells, get_used_cells' },
              x: { type: 'number', description: 'Cell X coordinate (for get_cell)' },
              y: { type: 'number', description: 'Cell Y coordinate (for get_cell)' },
              cells: { type: 'array', description: 'Array of cell objects for set_cells/erase_cells' },
              sourceId: { type: 'number', description: 'Filter by source_id (for get_used_cells)' },
            },
            required: ['nodePath', 'action'],
          },
        },
        {
          name: 'game_add_collision',
          description: 'Add a collision shape to a physics body node',
          inputSchema: {
            type: 'object',
            properties: {
              parentPath: { type: 'string', description: 'Path to CollisionBody/Area node' },
              shapeType: { type: 'string', description: 'Shape: box, sphere/circle, capsule, cylinder, ray, segment' },
              shapeParams: { type: 'object', description: 'Shape dimensions (e.g. {radius, height})' },
              collisionLayer: { type: 'number', description: 'Collision layer bitmask' },
              collisionMask: { type: 'number', description: 'Collision mask bitmask' },
              disabled: { type: 'boolean', description: 'Start disabled' },
            },
            required: ['parentPath', 'shapeType'],
          },
        },
        {
          name: 'game_environment',
          description: 'Get or set environment and post-processing settings',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Action: get or set. Default: set' },
              backgroundMode: { type: 'number', description: '0=clear, 1=custom_color, 2=sky, 3=canvas' },
              backgroundColor: { type: 'object', description: 'Background color {r,g,b,a}' },
              ambientLightColor: { type: 'object', description: 'Ambient light color {r,g,b,a}' },
              ambientLightEnergy: { type: 'number', description: 'Ambient light energy' },
              fogEnabled: { type: 'boolean', description: 'Enable fog' },
              fogDensity: { type: 'number', description: 'Fog density' },
              fogLightColor: { type: 'object', description: 'Fog light color {r,g,b,a}' },
              glowEnabled: { type: 'boolean', description: 'Enable glow' },
              glowIntensity: { type: 'number', description: 'Glow intensity' },
              glowBloom: { type: 'number', description: 'Glow bloom' },
              tonemapMode: { type: 'number', description: '0=linear, 1=reinhardt, 2=filmic, 3=aces' },
              ssaoEnabled: { type: 'boolean', description: 'Enable SSAO' },
              ssaoRadius: { type: 'number', description: 'SSAO radius' },
              ssaoIntensity: { type: 'number', description: 'SSAO intensity' },
              ssrEnabled: { type: 'boolean', description: 'Enable SSR' },
              brightness: { type: 'number', description: 'Brightness adjustment' },
              contrast: { type: 'number', description: 'Contrast adjustment' },
              saturation: { type: 'number', description: 'Saturation adjustment' },
            },
            required: [],
          },
        },
        // Group, timer, particles, animation, export, state, physics, joint, bone, theme, viewport, debug tools
        {
          name: 'game_manage_group',
          description: 'Add or remove a node from a group, or list groups',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to the node' },
              action: { type: 'string', description: 'Action: add, remove, get_groups, clear_group' },
              group: { type: 'string', description: 'Group name' },
            },
            required: ['action'],
          },
        },
        {
          name: 'game_create_timer',
          description: 'Create a Timer node with configuration',
          inputSchema: {
            type: 'object',
            properties: {
              parentPath: { type: 'string', description: 'Parent node path. Default: "/root"' },
              waitTime: { type: 'number', description: 'Timer duration in seconds. Default: 1.0' },
              oneShot: { type: 'boolean', description: 'One-shot mode. Default: false' },
              autostart: { type: 'boolean', description: 'Auto-start the timer. Default: false' },
              name: { type: 'string', description: 'Optional timer node name' },
            },
            required: [],
          },
        },
        {
          name: 'game_set_particles',
          description: 'Configure GPUParticles2D/3D node properties',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to GPUParticles node' },
              emitting: { type: 'boolean', description: 'Enable/disable emission' },
              amount: { type: 'number', description: 'Number of particles' },
              lifetime: { type: 'number', description: 'Particle lifetime in seconds' },
              oneShot: { type: 'boolean', description: 'One-shot mode' },
              speedScale: { type: 'number', description: 'Speed scale' },
              explosiveness: { type: 'number', description: 'Explosiveness ratio (0-1)' },
              randomness: { type: 'number', description: 'Randomness ratio (0-1)' },
              processMaterial: { type: 'object', description: 'ParticleProcessMaterial settings' },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'game_create_animation',
          description: 'Create an animation with tracks and keyframes',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to AnimationPlayer node' },
              animationName: { type: 'string', description: 'Name for the new animation' },
              length: { type: 'number', description: 'Animation length in seconds. Default: 1.0' },
              loopMode: { type: 'number', description: '0=none, 1=linear, 2=pingpong' },
              tracks: { type: 'array', description: 'Array of track definitions' },
              library: { type: 'string', description: 'Animation library name. Default: ""' },
            },
            required: ['nodePath', 'animationName'],
          },
        },
        {
          name: 'export_project',
          description: 'Export a Godot project using a preset',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Godot project path' },
              presetName: { type: 'string', description: 'Export preset name' },
              outputPath: { type: 'string', description: 'Output file path for the exported build' },
              debug: { type: 'boolean', description: 'Use debug export. Default: false' },
            },
            required: ['projectPath', 'presetName', 'outputPath'],
          },
        },
        {
          name: 'game_serialize_state',
          description: 'Save or load node tree state as JSON',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Root node path. Default: "/root"' },
              action: { type: 'string', description: 'Action: save or load. Default: save' },
              data: { type: 'object', description: 'State data to restore (for load)' },
              maxDepth: { type: 'number', description: 'Max tree depth to serialize. Default: 5' },
            },
            required: [],
          },
        },
        {
          name: 'game_physics_body',
          description: 'Configure physics body properties (mass, velocity, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to physics body node' },
              gravityScale: { type: 'number', description: 'Gravity scale' },
              mass: { type: 'number', description: 'Body mass' },
              linearVelocity: { type: 'object', description: 'Linear velocity {x,y} or {x,y,z}' },
              angularVelocity: { description: 'Angular velocity (float for 2D, {x,y,z} for 3D)' },
              linearDamp: { type: 'number', description: 'Linear damping' },
              angularDamp: { type: 'number', description: 'Angular damping' },
              friction: { type: 'number', description: 'Physics material friction' },
              bounce: { type: 'number', description: 'Physics material bounce' },
              freeze: { type: 'boolean', description: 'Freeze the body' },
              sleeping: { type: 'boolean', description: 'Put body to sleep' },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'game_create_joint',
          description: 'Create a physics joint between two bodies',
          inputSchema: {
            type: 'object',
            properties: {
              parentPath: { type: 'string', description: 'Parent node path for the joint' },
              jointType: { type: 'string', description: 'Joint type: pin_2d, spring_2d, groove_2d, pin_3d, hinge_3d, cone_3d, slider_3d' },
              nodeAPath: { type: 'string', description: 'Path to first body' },
              nodeBPath: { type: 'string', description: 'Path to second body' },
              stiffness: { type: 'number', description: 'Spring stiffness (spring_2d)' },
              damping: { type: 'number', description: 'Spring damping (spring_2d)' },
              length: { type: 'number', description: 'Length (spring_2d, groove_2d)' },
              softness: { type: 'number', description: 'Softness (pin_2d)' },
            },
            required: ['parentPath', 'jointType'],
          },
        },
        {
          name: 'game_bone_pose',
          description: 'Get or set bone poses on a Skeleton3D node',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to Skeleton3D node' },
              action: { type: 'string', description: 'Action: list, get, or set. Default: list' },
              boneIndex: { type: 'number', description: 'Bone index' },
              boneName: { type: 'string', description: 'Bone name (alternative to index)' },
              position: { type: 'object', description: 'Bone position {x,y,z}' },
              rotation: { type: 'object', description: 'Bone rotation quaternion {x,y,z,w}' },
              scale: { type: 'object', description: 'Bone scale {x,y,z}' },
            },
            required: ['nodePath'],
          },
        },
        {
          name: 'game_ui_theme',
          description: 'Apply theme overrides to a Control node',
          inputSchema: {
            type: 'object',
            properties: {
              nodePath: { type: 'string', description: 'Path to Control node' },
              overrides: { type: 'object', description: 'Theme overrides: {colors, constants, fontSizes}' },
            },
            required: ['nodePath', 'overrides'],
          },
        },
        {
          name: 'game_viewport',
          description: 'Create or configure a SubViewport node',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Action: create, configure, or get' },
              parentPath: { type: 'string', description: 'Parent path (for create)' },
              nodePath: { type: 'string', description: 'SubViewport path (for configure/get)' },
              width: { type: 'number', description: 'Viewport width' },
              height: { type: 'number', description: 'Viewport height' },
              msaa: { type: 'number', description: 'MSAA level (0=disabled, 1=2x, 2=4x, 3=8x)' },
              transparentBg: { type: 'boolean', description: 'Transparent background' },
              name: { type: 'string', description: 'Viewport name (for create)' },
            },
            required: [],
          },
        },
        {
          name: 'game_debug_draw',
          description: 'Draw debug lines, spheres, or boxes in 3D',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Action: line, sphere, box, or clear' },
              from: { type: 'object', description: 'Line start {x,y,z}' },
              to: { type: 'object', description: 'Line end {x,y,z}' },
              center: { type: 'object', description: 'Sphere/box center {x,y,z}' },
              radius: { type: 'number', description: 'Sphere radius. Default: 0.5' },
              size: { type: 'object', description: 'Box size {x,y,z}' },
              color: { type: 'object', description: 'Draw color {r,g,b,a}. Default: red' },
              duration: { type: 'number', description: 'Frames to persist (0=permanent)' },
            },
            required: ['action'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      switch (request.params.name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'create_scene':
          return await this.handleCreateScene(request.params.arguments);
        case 'add_node':
          return await this.handleAddNode(request.params.arguments);
        case 'load_sprite':
          return await this.handleLoadSprite(request.params.arguments);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return await this.handleSaveScene(request.params.arguments);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        case 'game_screenshot':
          return await this.handleGameScreenshot();
        case 'game_click':
          return await this.handleGameClick(request.params.arguments);
        case 'game_key_press':
          return await this.handleGameKeyPress(request.params.arguments);
        case 'game_mouse_move':
          return await this.handleGameMouseMove(request.params.arguments);
        case 'game_get_ui':
          return await this.handleGameGetUi();
        case 'game_get_scene_tree':
          return await this.handleGameGetSceneTree();
        // New runtime interaction tools
        case 'game_eval':
          return await this.handleGameEval(request.params.arguments);
        case 'game_get_property':
          return await this.handleGameGetProperty(request.params.arguments);
        case 'game_set_property':
          return await this.handleGameSetProperty(request.params.arguments);
        case 'game_call_method':
          return await this.handleGameCallMethod(request.params.arguments);
        case 'game_get_node_info':
          return await this.handleGameGetNodeInfo(request.params.arguments);
        case 'game_instantiate_scene':
          return await this.handleGameInstantiateScene(request.params.arguments);
        case 'game_remove_node':
          return await this.handleGameRemoveNode(request.params.arguments);
        case 'game_change_scene':
          return await this.handleGameChangeScene(request.params.arguments);
        case 'game_pause':
          return await this.handleGamePause(request.params.arguments);
        case 'game_performance':
          return await this.handleGamePerformance();
        case 'game_wait':
          return await this.handleGameWait(request.params.arguments);
        // Headless scene tools
        case 'read_scene':
          return await this.handleReadScene(request.params.arguments);
        case 'modify_scene_node':
          return await this.handleModifySceneNode(request.params.arguments);
        case 'remove_scene_node':
          return await this.handleRemoveSceneNode(request.params.arguments);
        // Project management tools
        case 'read_project_settings':
          return await this.handleReadProjectSettings(request.params.arguments);
        case 'modify_project_settings':
          return await this.handleModifyProjectSettings(request.params.arguments);
        case 'list_project_files':
          return await this.handleListProjectFiles(request.params.arguments);
        // New runtime signal/animation/group tools
        case 'game_connect_signal':
          return await this.handleGameConnectSignal(request.params.arguments);
        case 'game_disconnect_signal':
          return await this.handleGameDisconnectSignal(request.params.arguments);
        case 'game_emit_signal':
          return await this.handleGameEmitSignal(request.params.arguments);
        case 'game_play_animation':
          return await this.handleGamePlayAnimation(request.params.arguments);
        case 'game_tween_property':
          return await this.handleGameTweenProperty(request.params.arguments);
        case 'game_get_nodes_in_group':
          return await this.handleGameGetNodesInGroup(request.params.arguments);
        case 'game_find_nodes_by_class':
          return await this.handleGameFindNodesByClass(request.params.arguments);
        case 'game_reparent_node':
          return await this.handleGameReparentNode(request.params.arguments);
        // Headless resource tools
        case 'attach_script':
          return await this.handleAttachScript(request.params.arguments);
        case 'create_resource':
          return await this.handleCreateResource(request.params.arguments);
        // File I/O tools
        case 'read_file':
          return await this.handleReadFile(request.params.arguments);
        case 'write_file':
          return await this.handleWriteFile(request.params.arguments);
        case 'delete_file':
          return await this.handleDeleteFile(request.params.arguments);
        case 'create_directory':
          return await this.handleCreateDirectory(request.params.arguments);
        // Error/Log capture tools
        case 'game_get_errors':
          return await this.handleGameGetErrors();
        case 'game_get_logs':
          return await this.handleGameGetLogs();
        // Enhanced input tools
        case 'game_key_hold':
          return await this.handleGameKeyHold(request.params.arguments);
        case 'game_key_release':
          return await this.handleGameKeyRelease(request.params.arguments);
        case 'game_scroll':
          return await this.handleGameScroll(request.params.arguments);
        case 'game_mouse_drag':
          return await this.handleGameMouseDrag(request.params.arguments);
        case 'game_gamepad':
          return await this.handleGameGamepad(request.params.arguments);
        // Project management tools
        case 'create_project':
          return await this.handleCreateProject(request.params.arguments);
        case 'manage_autoloads':
          return await this.handleManageAutoloads(request.params.arguments);
        case 'manage_input_map':
          return await this.handleManageInputMap(request.params.arguments);
        case 'manage_export_presets':
          return await this.handleManageExportPresets(request.params.arguments);
        // Advanced runtime tools
        case 'game_get_camera':
          return await this.handleGameGetCamera();
        case 'game_set_camera':
          return await this.handleGameSetCamera(request.params.arguments);
        case 'game_raycast':
          return await this.handleGameRaycast(request.params.arguments);
        case 'game_get_audio':
          return await this.handleGameGetAudio();
        case 'game_spawn_node':
          return await this.handleGameSpawnNode(request.params.arguments);
        // Shader, audio, navigation, tilemap, collision, environment tools
        case 'game_set_shader_param':
          return await this.handleGameSetShaderParam(request.params.arguments);
        case 'game_audio_play':
          return await this.handleGameAudioPlay(request.params.arguments);
        case 'game_audio_bus':
          return await this.handleGameAudioBus(request.params.arguments);
        case 'game_navigate_path':
          return await this.handleGameNavigatePath(request.params.arguments);
        case 'game_tilemap':
          return await this.handleGameTilemap(request.params.arguments);
        case 'game_add_collision':
          return await this.handleGameAddCollision(request.params.arguments);
        case 'game_environment':
          return await this.handleGameEnvironment(request.params.arguments);
        // Group, timer, particles, animation, export, state, physics, joint, bone, theme, viewport, debug
        case 'game_manage_group':
          return await this.handleGameManageGroup(request.params.arguments);
        case 'game_create_timer':
          return await this.handleGameCreateTimer(request.params.arguments);
        case 'game_set_particles':
          return await this.handleGameSetParticles(request.params.arguments);
        case 'game_create_animation':
          return await this.handleGameCreateAnimation(request.params.arguments);
        case 'export_project':
          return await this.handleExportProject(request.params.arguments);
        case 'game_serialize_state':
          return await this.handleGameSerializeState(request.params.arguments);
        case 'game_physics_body':
          return await this.handleGamePhysicsBody(request.params.arguments);
        case 'game_create_joint':
          return await this.handleGameCreateJoint(request.params.arguments);
        case 'game_bone_pose':
          return await this.handleGameBonePose(request.params.arguments);
        case 'game_ui_theme':
          return await this.handleGameUiTheme(request.params.arguments);
        case 'game_viewport':
          return await this.handleGameViewport(request.params.arguments);
        case 'game_debug_draw':
          return await this.handleGameDebugDraw(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.disconnectFromGame();
        if (this.gameConnection.projectPath) {
          this.removeInteractionServer(this.gameConnection.projectPath);
        }
        this.activeProcess.process.kill();
      }

      // Inject interaction server before launching
      this.injectInteractionServer(args.projectPath);

      const cmdArgs = ['-d', '--path', args.projectPath];
      if (args.scene && validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
      const output: string[] = [];
      const errors: string[] = [];

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        this.disconnectFromGame();
        if (this.gameConnection.projectPath) {
          this.removeInteractionServer(this.gameConnection.projectPath);
          this.gameConnection.projectPath = null;
        }
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process, output, errors };

      // Start async TCP connection to the interaction server (fire-and-forget)
      this.connectToGame(args.projectPath).catch(err => {
        this.logDebug(`Failed to connect to game interaction server: ${err}`);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output. Game interaction server connecting on port ${this.INTERACTION_PORT}...`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return createErrorResponse(
        'No active Godot process.'
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return createErrorResponse(
        'No active Godot process to stop.'
      );
    }

    this.logDebug('Stopping active Godot process');
    this.disconnectFromGame();
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    this.activeProcess = null;
    this.lastErrorIndex = 0;
    this.lastLogIndex = 0;

    // Remove injected interaction server
    if (this.gameConnection.projectPath) {
      this.removeInteractionServer(this.gameConnection.projectPath);
      this.gameConnection.projectPath = null;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.directory) {
      return createErrorResponse(
        'Directory is required'
      );
    }

    if (!validatePath(args.directory)) {
      return createErrorResponse(
        'Invalid directory path'
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return createErrorResponse(
          `Directory does not exist: ${args.directory}`
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }
  
    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const projectFileContent = readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse(
        'Project path and scene path are required'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType: args.rootNodeType || 'Node2D',
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to create scene: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to add node: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (
      !validatePath(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.nodePath) ||
      !validatePath(args.texturePath)
    ) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to load sprite: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (
      !validatePath(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.outputPath)
    ) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to export mesh library: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !validatePath(args.newPath)) {
      return createErrorResponse(
        'Invalid new path'
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to save scene: ${stderr}`
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.filePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return createErrorResponse(
          `File does not exist: ${args.filePath}`
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to get UID: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`
      );
    }
  }


  /**
   * Handle the game_screenshot tool
   */
  private async handleGameScreenshot() {
    if (!this.activeProcess) {
      return createErrorResponse('No active Godot process. Use run_project first.');
    }
    if (!this.gameConnection.connected) {
      return createErrorResponse('Not connected to game interaction server. Wait a moment and try again.');
    }

    try {
      const response = await this.sendGameCommand('screenshot');
      if (response.error) {
        return createErrorResponse(`Screenshot failed: ${response.error}`);
      }
      return {
        content: [
          {
            type: 'image',
            data: response.data,
            mimeType: 'image/png',
          },
          {
            type: 'text',
            text: `Screenshot captured: ${response.width}x${response.height}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(`Screenshot failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleGameClick(args: any) {
    return this.gameCommand('click', args, a => ({ x: a.x ?? 0, y: a.y ?? 0, button: a.button ?? 1 }));
  }

  private async handleGameKeyPress(args: any) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, any> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    if (args.pressed !== undefined) params.pressed = args.pressed;
    return this.gameCommand('key_press', args, () => params);
  }

  private async handleGameMouseMove(args: any) {
    return this.gameCommand('mouse_move', args, a => ({
      x: a.x ?? 0, y: a.y ?? 0, relative_x: a.relative_x ?? 0, relative_y: a.relative_y ?? 0,
    }));
  }

  private async handleGameGetUi() {
    return this.gameCommand('get_ui_elements', {}, () => ({}));
  }

  private async handleGameGetSceneTree() {
    return this.gameCommand('get_scene_tree', {}, () => ({}));
  }

  private async handleGameEval(args: any) {
    args = normalizeParameters(args || {});
    if (!args.code) return createErrorResponse('code parameter is required.');
    return this.gameCommand('eval', args, a => ({ code: a.code }), 30000);
  }

  private async handleGameGetProperty(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
    return this.gameCommand('get_property', args, a => ({ node_path: a.nodePath, property: a.property }));
  }

  private async handleGameSetProperty(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
    return this.gameCommand('set_property', args, a => ({
      node_path: a.nodePath, property: a.property, value: a.value, type_hint: a.typeHint || '',
    }));
  }

  private async handleGameCallMethod(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.method) return createErrorResponse('nodePath and method are required.');
    return this.gameCommand('call_method', args, a => ({
      node_path: a.nodePath, method: a.method, args: a.args || [],
    }));
  }

  private async handleGameGetNodeInfo(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.gameCommand('get_node_info', args, a => ({ node_path: a.nodePath }));
  }

  private async handleGameInstantiateScene(args: any) {
    args = normalizeParameters(args || {});
    if (!args.scenePath) return createErrorResponse('scenePath is required.');
    return this.gameCommand('instantiate_scene', args, a => ({
      scene_path: a.scenePath, parent_path: a.parentPath || '/root',
    }));
  }

  private async handleGameRemoveNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.gameCommand('remove_node', args, a => ({ node_path: a.nodePath }));
  }

  private async handleGameChangeScene(args: any) {
    args = normalizeParameters(args || {});
    if (!args.scenePath) return createErrorResponse('scenePath is required.');
    return this.gameCommand('change_scene', args, a => ({ scene_path: a.scenePath }));
  }

  private async handleGamePause(args: any) {
    return this.gameCommand('pause', args, a => ({ paused: a.paused !== undefined ? a.paused : true }));
  }

  private async handleGamePerformance() {
    return this.gameCommand('get_performance', {}, () => ({}));
  }

  private async handleGameWait(args: any) {
    return this.gameCommand('wait', args, a => ({ frames: a.frames || 1 }), 30000);
  }


  /**
   * Handle the read_scene tool - Read a scene file structure
   */
  private async handleReadScene(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse('projectPath and scenePath are required.');
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse('Invalid path.');
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    const scenePath = join(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return createErrorResponse(`Scene file does not exist: ${args.scenePath}`);
    }

    try {
      const { stdout, stderr } = await this.executeOperation('read_scene', {
        scenePath: args.scenePath,
      }, args.projectPath);

      // Extract JSON from the SCENE_JSON_START/END markers
      const startMarker = 'SCENE_JSON_START';
      const endMarker = 'SCENE_JSON_END';
      const startIdx = stdout.indexOf(startMarker);
      const endIdx = stdout.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        const jsonStr = stdout.substring(startIdx + startMarker.length, endIdx).trim();
        try {
          const parsed = JSON.parse(jsonStr);
          return {
            content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
          };
        } catch {
          return {
            content: [{ type: 'text', text: `Raw scene data:\n${jsonStr}` }],
          };
        }
      }

      return {
        content: [{ type: 'text', text: `Scene read output:\n${stdout}\n${stderr ? 'Errors:\n' + stderr : ''}` }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to read scene: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle the modify_scene_node tool
   */
  private async handleModifySceneNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.properties)
      return createErrorResponse('projectPath, scenePath, nodePath, and properties are required.');
    return this.headlessOp('modify_node', args, a => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath, properties: a.properties },
    }));
  }

  private async handleRemoveSceneNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath)
      return createErrorResponse('projectPath, scenePath, and nodePath are required.');
    return this.headlessOp('remove_node', args, a => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath },
    }));
  }


  /**
   * Handle the read_project_settings tool - Parse project.godot as JSON
   */
  private async handleReadProjectSettings(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath) {
      return createErrorResponse('projectPath is required.');
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse('Invalid path.');
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    try {
      const content = readFileSync(projectFile, 'utf8');
      const sections: Record<string, Record<string, string>> = {};
      let currentSection = '';

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith(';')) continue;

        // Section header
        const sectionMatch = trimmed.match(/^\[(.+)\]$/);
        if (sectionMatch) {
          currentSection = sectionMatch[1];
          if (!sections[currentSection]) {
            sections[currentSection] = {};
          }
          continue;
        }

        // Key=value pair
        const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
        if (kvMatch && currentSection) {
          const key = kvMatch[1].trim();
          const value = kvMatch[2].trim();
          sections[currentSection][key] = value;
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to read project settings: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle the modify_project_settings tool - Change a project.godot setting
   */
  private async handleModifyProjectSettings(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.section || !args.key || args.value === undefined) {
      return createErrorResponse('projectPath, section, key, and value are required.');
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse('Invalid path.');
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    try {
      let content = readFileSync(projectFile, 'utf8');
      const sectionHeader = `[${args.section}]`;
      const keyLine = `${args.key}=${args.value}`;

      // Check if section exists
      const sectionIdx = content.indexOf(sectionHeader);
      if (sectionIdx !== -1) {
        // Section exists - look for existing key
        const sectionEnd = content.indexOf('\n[', sectionIdx + sectionHeader.length);
        const sectionContent = sectionEnd !== -1
          ? content.substring(sectionIdx, sectionEnd)
          : content.substring(sectionIdx);

        // Try to find and replace existing key
        const keyPattern = new RegExp(`^${args.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
        if (keyPattern.test(sectionContent)) {
          // Replace existing key
          const newSectionContent = sectionContent.replace(keyPattern, keyLine);
          content = content.substring(0, sectionIdx) + newSectionContent +
            (sectionEnd !== -1 ? content.substring(sectionEnd) : '');
        } else {
          // Add key to existing section
          const insertPos = sectionIdx + sectionHeader.length;
          content = content.substring(0, insertPos) + '\n' + keyLine + content.substring(insertPos);
        }
      } else {
        // Add new section at end
        content += `\n\n${sectionHeader}\n\n${keyLine}\n`;
      }

      writeFileSync(projectFile, content, 'utf8');
      return {
        content: [{ type: 'text', text: `Setting updated: [${args.section}] ${args.key}=${args.value}` }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to modify project settings: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle the list_project_files tool - List files with extension filtering
   */
  private async handleListProjectFiles(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath) {
      return createErrorResponse('projectPath is required.');
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse('Invalid path.');
    }

    if (!existsSync(args.projectPath)) {
      return createErrorResponse(`Directory does not exist: ${args.projectPath}`);
    }

    try {
      const baseDir = args.subdirectory
        ? join(args.projectPath, args.subdirectory)
        : args.projectPath;

      if (!existsSync(baseDir)) {
        return createErrorResponse(`Subdirectory does not exist: ${args.subdirectory}`);
      }

      const files: string[] = [];
      const extensions: string[] | undefined = args.extensions;

      const scanDir = (dir: string, relativeTo: string) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(dir, entry.name);
          const relativePath = fullPath.substring(relativeTo.length + 1).replace(/\\/g, '/');

          if (entry.isDirectory()) {
            scanDir(fullPath, relativeTo);
          } else if (entry.isFile()) {
            if (extensions && extensions.length > 0) {
              const ext = '.' + entry.name.split('.').pop();
              if (extensions.includes(ext)) {
                files.push(relativePath);
              }
            } else {
              files.push(relativePath);
            }
          }
        }
      };

      scanDir(baseDir, args.projectPath);

      return {
        content: [{ type: 'text', text: JSON.stringify({ count: files.length, files }, null, 2) }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to list project files: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleGameConnectSignal(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
      return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
    return this.gameCommand('connect_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
    }));
  }

  private async handleGameDisconnectSignal(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
      return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
    return this.gameCommand('disconnect_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
    }));
  }

  private async handleGameEmitSignal(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName) return createErrorResponse('nodePath and signalName are required.');
    return this.gameCommand('emit_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, args: a.args || [],
    }));
  }

  private async handleGamePlayAnimation(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.gameCommand('play_animation', args, a => ({
      node_path: a.nodePath, action: a.action || 'play', animation: a.animation || '',
    }));
  }

  private async handleGameTweenProperty(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property || args.finalValue === undefined)
      return createErrorResponse('nodePath, property, and finalValue are required.');
    return this.gameCommand('tween_property', args, a => ({
      node_path: a.nodePath, property: a.property, final_value: a.finalValue,
      duration: a.duration || 1.0, trans_type: a.transType || 0, ease_type: a.easeType || 2,
    }));
  }

  private async handleGameGetNodesInGroup(args: any) {
    args = normalizeParameters(args || {});
    if (!args.group) return createErrorResponse('group is required.');
    return this.gameCommand('get_nodes_in_group', args, a => ({ group: a.group }));
  }

  private async handleGameFindNodesByClass(args: any) {
    args = normalizeParameters(args || {});
    if (!args.className) return createErrorResponse('className is required.');
    return this.gameCommand('find_nodes_by_class', args, a => ({
      class_name: a.className, root_path: a.rootPath || '/root',
    }));
  }

  private async handleGameReparentNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.newParentPath) return createErrorResponse('nodePath and newParentPath are required.');
    return this.gameCommand('reparent_node', args, a => ({
      node_path: a.nodePath, new_parent_path: a.newParentPath, keep_global_transform: a.keepGlobalTransform !== false,
    }));
  }

  private async handleAttachScript(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.scriptPath)
      return createErrorResponse('projectPath, scenePath, nodePath, and scriptPath are required.');
    return this.headlessOp('attach_script', args, a => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath, scriptPath: a.scriptPath },
    }));
  }

  private async handleCreateResource(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.resourceType || !args.resourcePath)
      return createErrorResponse('projectPath, resourceType, and resourcePath are required.');
    return this.headlessOp('create_resource', args, a => ({
      projectPath: a.projectPath,
      params: { resourceType: a.resourceType, resourcePath: a.resourcePath, ...(a.properties ? { properties: a.properties } : {}) },
    }));
  }

  // --- File I/O handlers ---

  private async handleReadFile(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath)
      return createErrorResponse('projectPath and filePath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.filePath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const fullPath = join(args.projectPath, args.filePath);
    if (!existsSync(fullPath))
      return createErrorResponse(`File does not exist: ${args.filePath}`);
    try {
      const content = readFileSync(fullPath, 'utf8');
      return { content: [{ type: 'text', text: content }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to read file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleWriteFile(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath || args.content === undefined)
      return createErrorResponse('projectPath, filePath, and content are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.filePath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      const fullPath = join(args.projectPath, args.filePath);
      const parentDir = dirname(fullPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(fullPath, args.content, 'utf8');
      return { content: [{ type: 'text', text: `File written: ${args.filePath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to write file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleDeleteFile(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath)
      return createErrorResponse('projectPath and filePath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.filePath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const fullPath = join(args.projectPath, args.filePath);
    if (!existsSync(fullPath))
      return createErrorResponse(`File does not exist: ${args.filePath}`);
    try {
      unlinkSync(fullPath);
      return { content: [{ type: 'text', text: `File deleted: ${args.filePath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to delete file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleCreateDirectory(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.directoryPath)
      return createErrorResponse('projectPath and directoryPath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.directoryPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      const fullPath = join(args.projectPath, args.directoryPath);
      mkdirSync(fullPath, { recursive: true });
      return { content: [{ type: 'text', text: `Directory created: ${args.directoryPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to create directory: ${error?.message || 'Unknown error'}`);
    }
  }

  // --- Error/Log capture handlers ---

  private async handleGameGetErrors() {
    if (!this.activeProcess)
      return createErrorResponse('No active Godot process. Use run_project first.');
    const errors = this.activeProcess.errors.slice(this.lastErrorIndex);
    this.lastErrorIndex = this.activeProcess.errors.length;
    return { content: [{ type: 'text', text: JSON.stringify({ count: errors.length, errors }, null, 2) }] };
  }

  private async handleGameGetLogs() {
    if (!this.activeProcess)
      return createErrorResponse('No active Godot process. Use run_project first.');
    const logs = this.activeProcess.output.slice(this.lastLogIndex);
    this.lastLogIndex = this.activeProcess.output.length;
    return { content: [{ type: 'text', text: JSON.stringify({ count: logs.length, logs }, null, 2) }] };
  }

  // --- Enhanced input handlers ---

  private async handleGameKeyHold(args: any) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, any> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    return this.gameCommand('key_hold', args, () => params);
  }

  private async handleGameKeyRelease(args: any) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, any> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    return this.gameCommand('key_release', args, () => params);
  }

  private async handleGameScroll(args: any) {
    return this.gameCommand('scroll', args, a => ({
      x: a.x ?? 0, y: a.y ?? 0, direction: a.direction || 'up', amount: a.amount || 1,
    }));
  }

  private async handleGameMouseDrag(args: any) {
    args = normalizeParameters(args || {});
    if (args.fromX === undefined || args.fromY === undefined || args.toX === undefined || args.toY === undefined)
      return createErrorResponse('fromX, fromY, toX, and toY are required.');
    return this.gameCommand('mouse_drag', args, a => ({
      from_x: a.fromX, from_y: a.fromY, to_x: a.toX, to_y: a.toY,
      button: a.button || 1, steps: a.steps || 10,
    }), 30000);
  }

  private async handleGameGamepad(args: any) {
    args = normalizeParameters(args || {});
    if (!args.type || args.index === undefined || args.value === undefined)
      return createErrorResponse('type, index, and value are required.');
    return this.gameCommand('gamepad', args, a => ({
      type: a.type, index: a.index, value: a.value, device: a.device || 0,
    }));
  }

  // --- Project management handlers ---

  private async handleCreateProject(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.projectName)
      return createErrorResponse('projectPath and projectName are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    try {
      if (!existsSync(args.projectPath)) {
        mkdirSync(args.projectPath, { recursive: true });
      }
      const projectFile = join(args.projectPath, 'project.godot');
      if (existsSync(projectFile))
        return createErrorResponse('A project.godot already exists at this path.');
      const content = `; Engine configuration file.\n; Generated by Godot MCP.\n\nconfig_version=5\n\n[application]\n\nconfig/name="${args.projectName}"\nconfig/features=PackedStringArray("4.3")\n`;
      writeFileSync(projectFile, content, 'utf8');
      return { content: [{ type: 'text', text: `Project "${args.projectName}" created at ${args.projectPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to create project: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageAutoloads(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const autoloads: Record<string, string> = {};
        const autoloadMatch = content.match(/\[autoload\]([\s\S]*?)(?=\n\[|$)/);
        if (autoloadMatch) {
          for (const line of autoloadMatch[1].split('\n')) {
            const kv = line.trim().match(/^([^=]+)=(.*)$/);
            if (kv) autoloads[kv[1].trim()] = kv[2].trim();
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(autoloads, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.name || !args.path)
          return createErrorResponse('name and path are required for add action.');
        const autoloadLine = `${args.name}="*${args.path}"`;
        if (content.includes('[autoload]')) {
          content = content.replace('[autoload]', `[autoload]\n\n${autoloadLine}`);
        } else {
          content += `\n[autoload]\n\n${autoloadLine}\n`;
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Autoload "${args.name}" added: ${args.path}` }] };
      } else if (args.action === 'remove') {
        if (!args.name)
          return createErrorResponse('name is required for remove action.');
        const pattern = new RegExp(`\\n?${args.name}\\s*=.*\\n?`, 'g');
        content = content.replace(pattern, '\n');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Autoload "${args.name}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: any) {
      return createErrorResponse(`Failed to manage autoloads: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageInputMap(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const actions: Record<string, string> = {};
        const inputMatch = content.match(/\[input\]([\s\S]*?)(?=\n\[|$)/);
        if (inputMatch) {
          for (const line of inputMatch[1].split('\n')) {
            const kv = line.trim().match(/^([^=]+)=(.*)$/);
            if (kv) actions[kv[1].trim()] = kv[2].trim();
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(actions, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.actionName)
          return createErrorResponse('actionName is required for add action.');
        const deadzone = args.deadzone !== undefined ? args.deadzone : 0.5;
        let events = '';
        if (args.key) {
          events = `, "events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":${this.keyNameToScancode(args.key)},"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)]`;
        }
        const inputLine = `${args.actionName}={"deadzone": ${deadzone}${events}}`;
        if (content.includes('[input]')) {
          content = content.replace('[input]', `[input]\n\n${inputLine}`);
        } else {
          content += `\n[input]\n\n${inputLine}\n`;
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Input action "${args.actionName}" added.` }] };
      } else if (args.action === 'remove') {
        if (!args.actionName)
          return createErrorResponse('actionName is required for remove action.');
        const pattern = new RegExp(`\\n?${args.actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*\\n?`, 'g');
        content = content.replace(pattern, '\n');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Input action "${args.actionName}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: any) {
      return createErrorResponse(`Failed to manage input map: ${error?.message || 'Unknown error'}`);
    }
  }

  private keyNameToScancode(key: string): number {
    const map: Record<string, number> = {
      'A': 65, 'B': 66, 'C': 67, 'D': 68, 'E': 69, 'F': 70, 'G': 71, 'H': 72,
      'I': 73, 'J': 74, 'K': 75, 'L': 76, 'M': 77, 'N': 78, 'O': 79, 'P': 80,
      'Q': 81, 'R': 82, 'S': 83, 'T': 84, 'U': 85, 'V': 86, 'W': 87, 'X': 88,
      'Y': 89, 'Z': 90, 'SPACE': 32, 'ENTER': 16777221, 'ESCAPE': 16777217,
      'TAB': 16777218, 'BACKSPACE': 16777220, 'UP': 16777232, 'DOWN': 16777234,
      'LEFT': 16777231, 'RIGHT': 16777233, 'SHIFT': 16777237, 'CTRL': 16777238,
      'ALT': 16777240, 'F1': 16777244, 'F2': 16777245, 'F3': 16777246,
      'F4': 16777247, 'F5': 16777248, 'F6': 16777249, 'F7': 16777250,
      'F8': 16777251, 'F9': 16777252, 'F10': 16777253, 'F11': 16777254,
      'F12': 16777255,
    };
    const upper = key.toUpperCase();
    return map[upper] || (key.length === 1 ? key.charCodeAt(0) : 0);
  }

  private async handleManageExportPresets(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const presetsFile = join(args.projectPath, 'export_presets.cfg');
    try {
      if (args.action === 'list') {
        if (!existsSync(presetsFile))
          return { content: [{ type: 'text', text: JSON.stringify({ presets: [] }, null, 2) }] };
        const content = readFileSync(presetsFile, 'utf8');
        const presets: Array<{ name: string; platform: string }> = [];
        const nameMatches = content.matchAll(/name="([^"]+)"/g);
        const platformMatches = content.matchAll(/platform="([^"]+)"/g);
        const names = [...nameMatches].map(m => m[1]);
        const platforms = [...platformMatches].map(m => m[1]);
        for (let i = 0; i < names.length; i++) {
          presets.push({ name: names[i], platform: platforms[i] || 'unknown' });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ presets }, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.name || !args.platform)
          return createErrorResponse('name and platform are required for add action.');
        const runnable = args.runnable ? 'true' : 'false';
        const presetBlock = `\n[preset.${Date.now()}]\n\nname="${args.name}"\nplatform="${args.platform}"\nrunnable=${runnable}\n`;
        let content = existsSync(presetsFile) ? readFileSync(presetsFile, 'utf8') : '';
        content += presetBlock;
        writeFileSync(presetsFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Export preset "${args.name}" added for platform "${args.platform}".` }] };
      } else if (args.action === 'remove') {
        if (!args.name)
          return createErrorResponse('name is required for remove action.');
        if (!existsSync(presetsFile))
          return createErrorResponse('No export_presets.cfg file found.');
        let content = readFileSync(presetsFile, 'utf8');
        // Remove the preset section containing the given name
        const pattern = new RegExp(`\\[preset\\.[^\\]]+\\]\\s*\\n[\\s\\S]*?name="${args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?(?=\\[preset\\.|$)`, 'g');
        content = content.replace(pattern, '');
        writeFileSync(presetsFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Export preset "${args.name}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: any) {
      return createErrorResponse(`Failed to manage export presets: ${error?.message || 'Unknown error'}`);
    }
  }

  // --- Advanced runtime handlers ---

  private async handleGameGetCamera() {
    return this.gameCommand('get_camera', {}, () => ({}));
  }

  private async handleGameSetCamera(args: any) {
    return this.gameCommand('set_camera', args, a => ({
      ...(a.position ? { position: a.position } : {}),
      ...(a.rotation ? { rotation: a.rotation } : {}),
      ...(a.zoom ? { zoom: a.zoom } : {}),
      ...(a.fov !== undefined ? { fov: a.fov } : {}),
    }));
  }

  private async handleGameRaycast(args: any) {
    args = normalizeParameters(args || {});
    if (!args.from || !args.to)
      return createErrorResponse('from and to are required.');
    return this.gameCommand('raycast', args, a => ({
      from: a.from, to: a.to, collision_mask: a.collisionMask ?? 0xFFFFFFFF,
    }));
  }

  private async handleGameGetAudio() {
    return this.gameCommand('get_audio', {}, () => ({}));
  }

  private async handleGameSpawnNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.type)
      return createErrorResponse('type is required.');
    return this.gameCommand('spawn_node', args, a => ({
      type: a.type, name: a.name || '', parent_path: a.parentPath || '/root',
      ...(a.properties ? { properties: a.properties } : {}),
    }));
  }

  private async handleGameSetShaderParam(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.paramName)
      return createErrorResponse('nodePath and paramName are required.');
    return this.gameCommand('set_shader_param', args, a => ({
      node_path: a.nodePath, param_name: a.paramName, value: a.value,
      ...(a.typeHint ? { type_hint: a.typeHint } : {}),
    }));
  }

  private async handleGameAudioPlay(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('audio_play', args, a => ({
      node_path: a.nodePath, action: a.action || 'play',
      ...(a.stream ? { stream: a.stream } : {}),
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.pitch !== undefined ? { pitch: a.pitch } : {}),
      ...(a.bus ? { bus: a.bus } : {}),
      ...(a.fromPosition !== undefined ? { from_position: a.fromPosition } : {}),
    }));
  }

  private async handleGameAudioBus(args: any) {
    return this.gameCommand('audio_bus', args, a => ({
      bus_name: a.busName || 'Master',
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.mute !== undefined ? { mute: a.mute } : {}),
      ...(a.solo !== undefined ? { solo: a.solo } : {}),
    }));
  }

  private async handleGameNavigatePath(args: any) {
    args = normalizeParameters(args || {});
    if (!args.start || !args.end)
      return createErrorResponse('start and end are required.');
    return this.gameCommand('navigate_path', args, a => ({
      start: a.start, end: a.end, optimize: a.optimize ?? true,
    }));
  }

  private async handleGameTilemap(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.gameCommand('tilemap', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.cells ? { cells: a.cells } : {}),
      ...(a.sourceId !== undefined ? { source_id: a.sourceId } : {}),
    }));
  }

  private async handleGameAddCollision(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.shapeType)
      return createErrorResponse('parentPath and shapeType are required.');
    return this.gameCommand('add_collision', args, a => ({
      parent_path: a.parentPath, shape_type: a.shapeType,
      ...(a.shapeParams ? { shape_params: a.shapeParams } : {}),
      ...(a.collisionLayer !== undefined ? { collision_layer: a.collisionLayer } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
      ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    }));
  }

  private async handleGameEnvironment(args: any) {
    args = normalizeParameters(args || {});
    const params: Record<string, any> = { action: args.action || 'set' };
    // Pass through all environment settings
    const envKeys = [
      'backgroundMode', 'backgroundColor', 'ambientLightColor', 'ambientLightEnergy',
      'fogEnabled', 'fogDensity', 'fogLightColor',
      'glowEnabled', 'glowIntensity', 'glowBloom',
      'tonemapMode', 'ssaoEnabled', 'ssaoRadius', 'ssaoIntensity', 'ssrEnabled',
      'brightness', 'contrast', 'saturation',
    ];
    const snakeMap: Record<string, string> = {
      backgroundMode: 'background_mode', backgroundColor: 'background_color',
      ambientLightColor: 'ambient_light_color', ambientLightEnergy: 'ambient_light_energy',
      fogEnabled: 'fog_enabled', fogDensity: 'fog_density', fogLightColor: 'fog_light_color',
      glowEnabled: 'glow_enabled', glowIntensity: 'glow_intensity', glowBloom: 'glow_bloom',
      tonemapMode: 'tonemap_mode', ssaoEnabled: 'ssao_enabled', ssaoRadius: 'ssao_radius',
      ssaoIntensity: 'ssao_intensity', ssrEnabled: 'ssr_enabled',
      brightness: 'brightness', contrast: 'contrast', saturation: 'saturation',
    };
    for (const key of envKeys) {
      if (args[key] !== undefined) {
        params[snakeMap[key]] = args[key];
      }
    }
    return this.gameCommand('environment', { ...args }, () => params);
  }

  private async handleGameManageGroup(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.gameCommand('manage_group', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.group ? { group: a.group } : {}),
    }));
  }

  private async handleGameCreateTimer(args: any) {
    return this.gameCommand('create_timer', args, a => ({
      parent_path: a.parentPath || '/root',
      wait_time: a.waitTime ?? 1.0,
      one_shot: a.oneShot ?? false,
      autostart: a.autostart ?? false,
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameSetParticles(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('set_particles', args, a => ({
      node_path: a.nodePath,
      ...(a.emitting !== undefined ? { emitting: a.emitting } : {}),
      ...(a.amount !== undefined ? { amount: a.amount } : {}),
      ...(a.lifetime !== undefined ? { lifetime: a.lifetime } : {}),
      ...(a.oneShot !== undefined ? { one_shot: a.oneShot } : {}),
      ...(a.speedScale !== undefined ? { speed_scale: a.speedScale } : {}),
      ...(a.explosiveness !== undefined ? { explosiveness: a.explosiveness } : {}),
      ...(a.randomness !== undefined ? { randomness: a.randomness } : {}),
      ...(a.processMaterial ? { process_material: a.processMaterial } : {}),
    }));
  }

  private async handleGameCreateAnimation(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.animationName)
      return createErrorResponse('nodePath and animationName are required.');
    return this.gameCommand('create_animation', args, a => ({
      node_path: a.nodePath,
      animation_name: a.animationName,
      length: a.length ?? 1.0,
      loop_mode: a.loopMode ?? 0,
      tracks: a.tracks || [],
      ...(a.library !== undefined ? { library: a.library } : {}),
    }));
  }

  private async handleExportProject(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.presetName || !args.outputPath)
      return createErrorResponse('projectPath, presetName, and outputPath are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid project path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) return createErrorResponse('Could not find Godot executable.');
    }
    try {
      const exportFlag = args.debug ? '--export-debug' : '--export-release';
      const exportArgs = ['--headless', '--path', args.projectPath, exportFlag, args.presetName, args.outputPath];
      const { stdout, stderr } = await execFileAsync(this.godotPath!, exportArgs, { timeout: 120000 });
      if (stderr && stderr.includes('ERROR'))
        return createErrorResponse(`Export failed: ${stderr}`);
      return { content: [{ type: 'text', text: `Export succeeded.\n\nOutput: ${stdout || args.outputPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Export failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleGameSerializeState(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('serialize_state', args, a => ({
      node_path: a.nodePath || '/root',
      action: a.action || 'save',
      max_depth: a.maxDepth ?? 5,
      ...(a.data ? { data: a.data } : {}),
    }));
  }

  private async handleGamePhysicsBody(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('physics_body', args, a => ({
      node_path: a.nodePath,
      ...(a.gravityScale !== undefined ? { gravity_scale: a.gravityScale } : {}),
      ...(a.mass !== undefined ? { mass: a.mass } : {}),
      ...(a.linearVelocity ? { linear_velocity: a.linearVelocity } : {}),
      ...(a.angularVelocity !== undefined ? { angular_velocity: a.angularVelocity } : {}),
      ...(a.linearDamp !== undefined ? { linear_damp: a.linearDamp } : {}),
      ...(a.angularDamp !== undefined ? { angular_damp: a.angularDamp } : {}),
      ...(a.friction !== undefined ? { friction: a.friction } : {}),
      ...(a.bounce !== undefined ? { bounce: a.bounce } : {}),
      ...(a.freeze !== undefined ? { freeze: a.freeze } : {}),
      ...(a.sleeping !== undefined ? { sleeping: a.sleeping } : {}),
    }));
  }

  private async handleGameCreateJoint(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.jointType)
      return createErrorResponse('parentPath and jointType are required.');
    return this.gameCommand('create_joint', args, a => ({
      parent_path: a.parentPath,
      joint_type: a.jointType,
      ...(a.nodeAPath ? { node_a_path: a.nodeAPath } : {}),
      ...(a.nodeBPath ? { node_b_path: a.nodeBPath } : {}),
      ...(a.stiffness !== undefined ? { stiffness: a.stiffness } : {}),
      ...(a.damping !== undefined ? { damping: a.damping } : {}),
      ...(a.length !== undefined ? { length: a.length } : {}),
      ...(a.restLength !== undefined ? { rest_length: a.restLength } : {}),
      ...(a.softness !== undefined ? { softness: a.softness } : {}),
      ...(a.initialOffset !== undefined ? { initial_offset: a.initialOffset } : {}),
    }));
  }

  private async handleGameBonePose(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('bone_pose', args, a => ({
      node_path: a.nodePath,
      action: a.action || 'list',
      ...(a.boneIndex !== undefined ? { bone_index: a.boneIndex } : {}),
      ...(a.boneName ? { bone_name: a.boneName } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.rotation ? { rotation: a.rotation } : {}),
      ...(a.scale ? { scale: a.scale } : {}),
    }));
  }

  private async handleGameUiTheme(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.overrides)
      return createErrorResponse('nodePath and overrides are required.');
    return this.gameCommand('ui_theme', args, a => ({
      node_path: a.nodePath,
      overrides: a.overrides,
    }));
  }

  private async handleGameViewport(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('viewport', args, a => ({
      action: a.action || 'create',
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.msaa !== undefined ? { msaa: a.msaa } : {}),
      ...(a.transparentBg !== undefined ? { transparent_bg: a.transparentBg } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameDebugDraw(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.gameCommand('debug_draw', args, a => ({
      action: a.action,
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.center ? { center: a.center } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.size ? { size: a.size } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.duration !== undefined ? { duration: a.duration } : {}),
    }));
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to update project UIDs: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
