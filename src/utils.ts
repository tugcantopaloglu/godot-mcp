/**
 * Shared utilities for the Godot MCP server.
 * Pure functions extracted for testability.
 */

import { isAbsolute, join, normalize } from 'node:path';

export interface OperationParams {
  [key: string]: any;
}

export const PARAMETER_MAPPINGS: Record<string, string> = {
  'project_path': 'projectPath',
  'scene_path': 'scenePath',
  'root_node_type': 'rootNodeType',
  'parent_node_path': 'parentNodePath',
  'node_type': 'nodeType',
  'node_name': 'nodeName',
  'texture_path': 'texturePath',
  'node_path': 'nodePath',
  'output_path': 'outputPath',
  'mesh_item_names': 'meshItemNames',
  'new_path': 'newPath',
  'file_path': 'filePath',
  'directory': 'directory',
  'recursive': 'recursive',
  'scene': 'scene',
  'type_hint': 'typeHint',
  'parent_path': 'parentPath',
  'signal_name': 'signalName',
  'target_path': 'targetPath',
  'class_name': 'className',
  'root_path': 'rootPath',
  'new_parent_path': 'newParentPath',
  'keep_global_transform': 'keepGlobalTransform',
  'script_path': 'scriptPath',
  'resource_type': 'resourceType',
  'resource_path': 'resourcePath',
  'final_value': 'finalValue',
  'trans_type': 'transType',
  'ease_type': 'easeType',
  'directory_path': 'directoryPath',
  'from_x': 'fromX',
  'from_y': 'fromY',
  'to_x': 'toX',
  'to_y': 'toY',
  'project_name': 'projectName',
  'action_name': 'actionName',
  'param_name': 'paramName',
  'shape_type': 'shapeType',
  'shape_params': 'shapeParams',
  'bus_name': 'busName',
  'from_position': 'fromPosition',
  'collision_layer': 'collisionLayer',
  'collision_mask': 'collisionMask',
  'source_id': 'sourceId',
  'atlas_x': 'atlasX',
  'atlas_y': 'atlasY',
  'alt_tile': 'altTile',
  'background_mode': 'backgroundMode',
  'background_color': 'backgroundColor',
  'ambient_light_color': 'ambientLightColor',
  'ambient_light_energy': 'ambientLightEnergy',
  'fog_enabled': 'fogEnabled',
  'fog_density': 'fogDensity',
  'fog_light_color': 'fogLightColor',
  'glow_enabled': 'glowEnabled',
  'glow_intensity': 'glowIntensity',
  'glow_bloom': 'glowBloom',
  'tonemap_mode': 'tonemapMode',
  'ssao_enabled': 'ssaoEnabled',
  'ssao_radius': 'ssaoRadius',
  'ssao_intensity': 'ssaoIntensity',
  'ssr_enabled': 'ssrEnabled',
  'wait_time': 'waitTime',
  'one_shot': 'oneShot',
  'speed_scale': 'speedScale',
  'process_material': 'processMaterial',
  'initial_velocity_min': 'initialVelocityMin',
  'initial_velocity_max': 'initialVelocityMax',
  'scale_min': 'scaleMin',
  'scale_max': 'scaleMax',
  'animation_name': 'animationName',
  'loop_mode': 'loopMode',
  'max_depth': 'maxDepth',
  'gravity_scale': 'gravityScale',
  'linear_velocity': 'linearVelocity',
  'angular_velocity': 'angularVelocity',
  'linear_damp': 'linearDamp',
  'angular_damp': 'angularDamp',
  'joint_type': 'jointType',
  'node_a_path': 'nodeAPath',
  'node_b_path': 'nodeBPath',
  'rest_length': 'restLength',
  'initial_offset': 'initialOffset',
  'bone_index': 'boneIndex',
  'bone_name': 'boneName',
  'font_sizes': 'fontSizes',
  'transparent_bg': 'transparentBg',
  'render_target_update_mode': 'renderTargetUpdateMode',
  'preset_name': 'presetName',
  // Batch 1-5 new parameter mappings
  'max_clients': 'maxClients',
  'mouse_mode': 'mouseMode',
  'time_scale': 'timeScale',
  'gravity_direction': 'gravityDirection',
  'physics_fps': 'physicsFps',
  'csg_type': 'csgType',
  'mesh_type': 'meshType',
  'light_type': 'lightType',
  'spot_angle': 'spotAngle',
  'effect_type': 'effectType',
  'gi_type': 'giType',
  'sky_type': 'skyType',
  'top_color': 'topColor',
  'bottom_color': 'bottomColor',
  'sun_energy': 'sunEnergy',
  'ground_color': 'groundColor',
  'dof_blur_far': 'dofBlurFar',
  'dof_blur_near': 'dofBlurNear',
  'dof_blur_amount': 'dofBlurAmount',
  'exposure_multiplier': 'exposureMultiplier',
  'auto_exposure': 'autoExposure',
  'auto_exposure_scale': 'autoExposureScale',
  'cell_size': 'cellSize',
  'agent_radius': 'agentRadius',
  'agent_height': 'agentHeight',
  'motion_scale': 'motionScale',
  'motion_offset': 'motionOffset',
  'state_name': 'stateName',
  'param_value': 'paramValue',
  'send_to': 'sendTo',
  'max_distance': 'maxDistance',
  'unit_size': 'unitSize',
  'max_db': 'maxDb',
  'attenuation_model': 'attenuationModel',
  'layer_type': 'layerType',
  'plugin_name': 'pluginName',
  'shader_path': 'shaderPath',
  'shader_type': 'shaderType',
  'translation_path': 'translationPath',
  'anchor_preset': 'anchorPreset',
  'mouse_filter': 'mouseFilter',
  'min_size': 'minSize',
  'caret_position': 'caretPosition',
  'selection_from': 'selectionFrom',
  'selection_to': 'selectionTo',
  'item_path': 'itemPath',
  'min_value': 'minValue',
  'max_value': 'maxValue',
  'msaa_2d': 'msaa2d',
  'msaa_3d': 'msaa3d',
  'scaling_mode': 'scalingMode',
  'scaling_scale': 'scalingScale',
  'source_path': 'sourcePath',
  'new_name': 'newName',
};

export const REVERSE_PARAMETER_MAPPINGS: Record<string, string> = Object.fromEntries(
  Object.entries(PARAMETER_MAPPINGS).map(([snake, camel]) => [camel, snake])
);

export function normalizeParameters(params: OperationParams): OperationParams {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      let normalizedKey = key;

      if (key.includes('_') && PARAMETER_MAPPINGS[key]) {
        normalizedKey = PARAMETER_MAPPINGS[key];
      }

      if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
        result[normalizedKey] = normalizeParameters(params[key] as OperationParams);
      } else {
        result[normalizedKey] = params[key];
      }
    }
  }

  return result;
}

export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey = REVERSE_PARAMETER_MAPPINGS[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

      if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
        result[snakeKey] = convertCamelToSnakeCase(params[key] as OperationParams);
      } else {
        result[snakeKey] = params[key];
      }
    }
  }

  return result;
}

export function validatePath(path: string): boolean {
  if (!path || path.includes('..')) {
    return false;
  }

  return true;
}

export function validateProjectPath(path: string): boolean {
  if (!validatePath(path)) {
    return false;
  }

  const scopedPath = normalizeScopedPath(path);
  const allowedRoots = getAllowedProjectRoots();
  if (!isAbsolute(scopedPath)) {
    return allowedRoots.length === 0;
  }

  if (allowedRoots.length === 0) {
    return true;
  }

  return allowedRoots.some(root => scopedPath === root || scopedPath.startsWith(`${root}/`));
}

function getAllowedProjectRoots(): string[] {
  return (process.env.GODOT_MCP_PROJECT_ROOTS ?? '')
    .split(',')
    .map(root => root.trim())
    .filter(Boolean)
    .map(normalizeScopedPath);
}

function normalizeScopedPath(path: string): string {
  if (!path) return '';
  const wslPath = isWindowsAbsoluteDrivePath(path) ? toWslProjectPath(path) : path;
  return stripTrailingForwardSlashes(normalize(wslPath).replaceAll('\\', '/'));
}

function isWindowsAbsoluteDrivePath(path: string): boolean {
  if (path.length < 3 || path.charCodeAt(1) !== 58) return false;
  const drive = path.charCodeAt(0);
  const separator = path.charCodeAt(2);
  const isDriveLetter = (drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122);
  return isDriveLetter && (separator === 47 || separator === 92);
}

function stripTrailingForwardSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === path.length ? path : path.slice(0, end);
}

export function createErrorResponse(message: string): any {
  console.error(`[SERVER] Error response: ${message}`);

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
}

export function isGodot44OrLater(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (match) {
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return major > 4 || (major === 4 && minor >= 4);
  }
  return false;
}

/**
 * Convert a Windows-style path (e.g. "C:/foo/bar" or "C:\\foo\\bar") into the
 * WSL mount form ("/mnt/c/foo/bar"). Paths that aren't Windows-native pass
 * through unchanged. Only active on linux — on Windows and macOS the native
 * fs layer resolves paths directly.
 */
export function toWslProjectPath(p: string): string {
  if (!p || process.platform !== 'linux') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll('\\', '/')}` : p;
}

/**
 * Inverse of toWslProjectPath. Converts "/mnt/c/foo/bar" back to "C:/foo/bar"
 * so a Windows-native Godot executable (Godot.exe invoked via WSL interop)
 * receives a path it can open. Passthrough for non-mount paths. Linux-only.
 */
export function toNativeProjectPath(p: string): string {
  if (!p || process.platform !== 'linux') return p;
  const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

/**
 * True when the configured Godot executable is a Windows binary invoked via
 * WSL interop. Used to decide whether child processes need a Windows-style
 * project path rather than the /mnt/... form.
 */
export function isWindowsGodotExe(godotPath: string | null | undefined): boolean {
  return !!godotPath && godotPath.toLowerCase().endsWith('.exe');
}

/**
 * Join a project directory with a relative path, translating Windows-style
 * inputs to the WSL mount form first so Node's fs layer can resolve them on
 * linux. Use for every filesystem access that combines a user-supplied
 * project path with a known relative path — project.godot, Dockerfile, a
 * script under the project, etc.
 */
export function projectFilePath(projectPath: string, ...parts: string[]): string {
  return join(toWslProjectPath(projectPath), ...parts);
}

/** Backwards-compat alias pinned to project.godot. */
export function projectGodotFile(projectPath: string): string {
  return projectFilePath(projectPath, 'project.godot');
}

export function addGodotIniSectionLine(content: string, section: string, line: string, key: string): string {
  const newline = detectNewline(content);
  const parsed = splitGodotIniLines(content);
  const lines = parsed.lines;
  const sectionIndex = findGodotIniSection(lines, section);

  if (sectionIndex !== -1) {
    const sectionEnd = findGodotIniSectionEnd(lines, sectionIndex + 1);
    for (let i = sectionIndex + 1; i < sectionEnd; i++) {
      if (godotIniLineMatchesKey(lines[i], key)) {
        return content;
      }
    }

    // Append after the last existing entry, skipping back over trailing blank
    // lines. This keeps Godot's blank line after the header intact so removal
    // can splice just our line back out and round-trip byte-for-byte.
    let insertIndex = sectionEnd;
    while (insertIndex > sectionIndex + 1 && lines[insertIndex - 1].trim() === '') {
      insertIndex--;
    }
    lines.splice(insertIndex, 0, line);
    return joinGodotIniLines(lines, newline, parsed.trailingNewline);
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push(`[${section}]`, line);
  return joinGodotIniLines(lines, newline, true);
}

export function removeGodotIniSectionLine(content: string, section: string, key: string): string {
  const newline = detectNewline(content);
  const parsed = splitGodotIniLines(content);
  const lines = parsed.lines;
  const sectionIndex = findGodotIniSection(lines, section);
  if (sectionIndex === -1) {
    return content;
  }

  let changed = false;
  let sectionEnd = findGodotIniSectionEnd(lines, sectionIndex + 1);
  for (let i = sectionEnd - 1; i > sectionIndex; i--) {
    if (godotIniLineMatchesKey(lines[i], key)) {
      lines.splice(i, 1);
      changed = true;
    }
  }
  if (!changed) {
    return content;
  }

  sectionEnd = findGodotIniSectionEnd(lines, sectionIndex + 1);
  const hasRemainingContent = lines
    .slice(sectionIndex + 1, sectionEnd)
    .some(sectionLine => sectionLine.trim() !== '');

  // Other entries remain: drop only the matched line(s) and leave the
  // surrounding whitespace untouched, so Godot's blank line after the header
  // and before the next section survive and the file round-trips unchanged.
  if (hasRemainingContent) {
    return joinGodotIniLines(lines, newline, parsed.trailingNewline && lines.length > 0);
  }

  // The section is now empty, meaning we injected it wholesale: remove the
  // header and the separator blank line we added in front of it.
  lines.splice(sectionIndex, sectionEnd - sectionIndex);
  if (sectionIndex === lines.length && lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  } else if (
    sectionIndex > 0 &&
    sectionIndex < lines.length &&
    lines[sectionIndex - 1].trim() === '' &&
    lines[sectionIndex].trim() === ''
  ) {
    lines.splice(sectionIndex, 1);
  }

  return joinGodotIniLines(lines, newline, parsed.trailingNewline && lines.length > 0);
}

function splitGodotIniLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content.length === 0) {
    return { lines: [], trailingNewline: false };
  }

  const trailingNewline = /\r?\n$/.test(content);
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function joinGodotIniLines(lines: string[], newline: string, trailingNewline: boolean): string {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.join(newline)}${trailingNewline ? newline : ''}`;
}

function detectNewline(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function findGodotIniSection(lines: string[], section: string): number {
  return lines.findIndex(line => line.trim() === `[${section}]`);
}

function findGodotIniSectionEnd(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      return i;
    }
  }
  return lines.length;
}

function godotIniLineMatchesKey(line: string, key: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(';')) {
    return false;
  }
  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) {
    return false;
  }
  return trimmed.slice(0, separatorIndex).trim() === key;
}

/**
 * Parse a Godot-style INI file (project.godot, export_presets.cfg, …) into a
 * `{ section: { key: value } }` map. Unlike a naive line-by-line parser this
 * concatenates continuation lines for values whose RHS starts with `{`, `[`,
 * or a quoted string and whose closing delimiter lives on a later line —
 * required for Godot's input map, where each action is serialized as a
 * multi-line dictionary:
 *
 *   PaintGrass={
 *   "deadzone": 0.5,
 *   "events": [Object(InputEventKey,"keycode":71,…)]
 *   }
 *
 * Depth tracking ignores braces/brackets that appear inside double-quoted
 * string literals so embedded `}` characters don't close the block early.
 * Returns raw string values — callers can JSON.parse them if needed.
 */
export function parseGodotIni(content: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  const lines = content.split('\n');
  let currentSection = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';')) {
      i++;
      continue;
    }

    // Section header
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections[currentSection]) sections[currentSection] = {};
      i++;
      continue;
    }

    // Key=value pair, possibly spanning multiple lines. String state carries
    // across lines so a literal that opens on one line and closes on a later
    // line doesn't confuse depth tracking.
    const kvMatch = /^([^=]+)=(.*)$/.exec(trimmed);
    if (kvMatch && currentSection) {
      const key = kvMatch[1].trim();
      const walker = { depth: 0, inString: false };
      let value = kvMatch[2];
      stepIniDepth(value, walker);
      i++;
      while (walker.depth > 0 && i < lines.length) {
        value += '\n' + lines[i];
        stepIniDepth(lines[i], walker);
        i++;
      }
      sections[currentSection][key] = value.trim();
      continue;
    }
    i++;
  }

  return sections;
}

interface IniDepthWalker {
  depth: number;
  inString: boolean;
}

function stepIniDepth(text: string, w: IniDepthWalker): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && w.inString && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === '"') {
      w.inString = !w.inString;
      continue;
    }
    if (w.inString) continue;
    if (ch === '{' || ch === '[') w.depth++;
    else if (ch === '}' || ch === ']') w.depth--;
  }
}

/**
 * Translate an arbitrary linux path into a form a Windows Godot.exe (invoked
 * via WSL interop) can open:
 *   - `/mnt/<c>/...`  → `C:/...`
 *   - `/home/...`, `/usr/...`, etc. → `\\wsl.localhost\<distro>\<rest>`
 *   - Windows-native paths (`C:/...`) pass through
 *
 * Only active when godotPath is a .exe on linux; otherwise returns the input
 * unchanged. Distro name comes from $WSL_DISTRO_NAME when available,
 * defaulting to "Ubuntu".
 */
export function toWindowsAccessiblePath(
  p: string,
  godotPath: string | null | undefined
): string {
  if (!p || !isWindowsGodotExe(godotPath) || process.platform !== 'linux') return p;
  // Already a Windows UNC path (\\server\share\…). Leave alone so we don't
  // stack a second UNC prefix.
  if (p.startsWith('\\\\') || p.startsWith('//')) return p;
  // Windows drive form — accept "C:", "C:/…", "C:\…", and drive-relative
  // "C:foo". Anything with a drive letter is already native; pass through.
  if (/^[A-Za-z]:/.test(p)) return p;
  // /mnt/<letter>/... → <Letter>:/...
  const mnt = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(p);
  if (mnt) return `${mnt[1].toUpperCase()}:/${mnt[2] ?? ''}`;
  // Only rewrite absolute linux paths. Relative paths (no leading slash) are
  // left alone — callers that build an absolute path for Godot should do so
  // before calling us.
  if (!p.startsWith('/')) return p;
  // Linux-native absolute path → WSL UNC (backslash-separated for Windows).
  const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  return `\\\\wsl.localhost\\${distro}\\${p.slice(1).replaceAll('/', '\\')}`;
}
