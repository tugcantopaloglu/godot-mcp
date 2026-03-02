/**
 * Shared utilities for the Godot MCP server.
 * Pure functions extracted for testability.
 */

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
