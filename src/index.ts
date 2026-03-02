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
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';
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
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
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
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
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
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
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
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.disconnectFromGame();
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    this.activeProcess = null;

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
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
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
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
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
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!validatePath(args.directory)) {
      return createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
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
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
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
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
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
        const fs = require('fs');
        const projectFileContent = fs.readFileSync(projectFile, 'utf8');
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
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
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
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
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
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
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
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
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
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !validatePath(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.nodePath) ||
      !validatePath(args.texturePath)
    ) {
      return createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
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
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
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
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !validatePath(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.outputPath)
    ) {
      return createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
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
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
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
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !validatePath(args.newPath)) {
      return createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
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
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
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
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.filePath)) {
      return createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
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
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
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
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
    if (!(args || {}).group) return createErrorResponse('group is required.');
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

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
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
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
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
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
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
