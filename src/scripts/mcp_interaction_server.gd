extends Node

# MCP Interaction Server - TCP server for game interaction
# Runs as an autoload inside the Godot game, accepting JSON commands over TCP.
# No class_name to avoid autoload conflict.

var _server: TCPServer
var _client: StreamPeerTCP
var _buffer: String = ""
var _busy: bool = false
const PORT: int = 9090

func _ready() -> void:
	# Ensure MCP server keeps processing even when game is paused
	process_mode = Node.PROCESS_MODE_ALWAYS
	_server = TCPServer.new()
	var err: int = _server.listen(PORT, "127.0.0.1")
	if err != OK:
		push_error("McpInteractionServer: Failed to listen on port %d, error: %d" % [PORT, err])
		return
	print("McpInteractionServer: Listening on 127.0.0.1:%d" % PORT)


func _process(_delta: float) -> void:
	if _server == null:
		return

	# Accept new connections
	if _server.is_connection_available():
		var new_client: StreamPeerTCP = _server.take_connection()
		if new_client != null:
			if _client != null:
				_client.disconnect_from_host()
			_client = new_client
			_buffer = ""
			print("McpInteractionServer: Client connected")

	# Read data from client
	if _client == null:
		return

	_client.poll()
	var status: int = _client.get_status()
	if status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
		print("McpInteractionServer: Client disconnected")
		_client = null
		_buffer = ""
		return

	if status != StreamPeerTCP.STATUS_CONNECTED:
		return

	var available: int = _client.get_available_bytes()
	if available > 0:
		var data: Array = _client.get_data(available)
		if data[0] == OK:
			var bytes: PackedByteArray = data[1]
			_buffer += bytes.get_string_from_utf8()

			# Process complete lines (newline-delimited JSON)
			while _buffer.find("\n") >= 0:
				var newline_pos: int = _buffer.find("\n")
				var line: String = _buffer.substr(0, newline_pos).strip_edges()
				_buffer = _buffer.substr(newline_pos + 1)
				if line.length() > 0:
					_handle_command(line)


func _handle_command(json_str: String) -> void:
	if _busy:
		_send_response_raw({"error": "Server busy processing another command. Try again."})
		return
	_busy = true

	var json: JSON = JSON.new()
	var parse_err: int = json.parse(json_str)
	if parse_err != OK:
		_send_response({"error": "Invalid JSON: %s" % json.get_error_message()})
		return

	var data: Variant = json.data
	if not data is Dictionary:
		_send_response({"error": "Expected JSON object"})
		return

	var command: String = data.get("command", "")
	var params: Dictionary = data.get("params", {})

	match command:
		# Async commands (use await)
		"screenshot":
			await _cmd_screenshot()
		"click":
			await _cmd_click(params)
		"key_press":
			await _cmd_key_press(params)
		"eval":
			await _cmd_eval(params)
		"wait":
			await _cmd_wait(params)
		# Sync commands
		"mouse_move":
			_cmd_mouse_move(params)
		"get_ui_elements":
			_cmd_get_ui_elements()
		"get_scene_tree":
			_cmd_get_scene_tree()
		"get_property":
			_cmd_get_property(params)
		"set_property":
			_cmd_set_property(params)
		"call_method":
			_cmd_call_method(params)
		"get_node_info":
			_cmd_get_node_info(params)
		"instantiate_scene":
			_cmd_instantiate_scene(params)
		"remove_node":
			_cmd_remove_node(params)
		"change_scene":
			_cmd_change_scene(params)
		"pause":
			_cmd_pause(params)
		"get_performance":
			_cmd_get_performance(params)
		"connect_signal":
			_cmd_connect_signal(params)
		"disconnect_signal":
			_cmd_disconnect_signal(params)
		"emit_signal":
			_cmd_emit_signal(params)
		"play_animation":
			_cmd_play_animation(params)
		"tween_property":
			_cmd_tween_property(params)
		"get_nodes_in_group":
			_cmd_get_nodes_in_group(params)
		"find_nodes_by_class":
			_cmd_find_nodes_by_class(params)
		"reparent_node":
			_cmd_reparent_node(params)
		_:
			_send_response({"error": "Unknown command: %s" % command})


# Send response and clear busy flag
func _send_response(data: Dictionary) -> void:
	_busy = false
	_send_response_raw(data)


# Send response without clearing busy flag (used when rejecting during busy state)
func _send_response_raw(data: Dictionary) -> void:
	if _client == null:
		return
	var json_str: String = JSON.stringify(data) + "\n"
	var bytes: PackedByteArray = json_str.to_utf8_buffer()
	_client.put_data(bytes)


# --- Screenshot ---
func _cmd_screenshot() -> void:
	# Wait one frame so the viewport is fully rendered
	await get_tree().process_frame
	var image: Image = get_viewport().get_texture().get_image()
	if image == null:
		_send_response({"error": "Failed to capture screenshot"})
		return
	var png_buffer: PackedByteArray = image.save_png_to_buffer()
	var base64_str: String = Marshalls.raw_to_base64(png_buffer)
	_send_response({
		"success": true,
		"data": base64_str,
		"width": image.get_width(),
		"height": image.get_height()
	})


# --- Click ---
func _cmd_click(params: Dictionary) -> void:
	var x: float = float(params.get("x", 0))
	var y: float = float(params.get("y", 0))
	var button: int = int(params.get("button", MOUSE_BUTTON_LEFT))

	var pos: Vector2 = Vector2(x, y)

	# Mouse button press
	var press_event: InputEventMouseButton = InputEventMouseButton.new()
	press_event.position = pos
	press_event.global_position = pos
	press_event.button_index = button as MouseButton
	press_event.pressed = true
	Input.parse_input_event(press_event)

	# Wait a frame then release
	await get_tree().process_frame

	var release_event: InputEventMouseButton = InputEventMouseButton.new()
	release_event.position = pos
	release_event.global_position = pos
	release_event.button_index = button as MouseButton
	release_event.pressed = false
	Input.parse_input_event(release_event)

	_send_response({"success": true, "clicked": {"x": x, "y": y, "button": button}})


# --- Key Press ---
func _cmd_key_press(params: Dictionary) -> void:
	var action: String = params.get("action", "")
	var key: String = params.get("key", "")
	var pressed: bool = params.get("pressed", true)

	if action.length() > 0:
		# Simulate an action press/release
		if pressed:
			Input.action_press(action)
		else:
			Input.action_release(action)
		_send_response({"success": true, "action": action, "pressed": pressed})
		return

	if key.length() > 0:
		var keycode: int = _string_to_keycode(key)
		if keycode == KEY_NONE:
			_send_response({"error": "Unknown key: %s" % key})
			return

		var event: InputEventKey = InputEventKey.new()
		event.keycode = keycode as Key
		event.physical_keycode = keycode as Key
		event.pressed = pressed
		Input.parse_input_event(event)

		if pressed:
			# Auto-release after a frame
			await get_tree().process_frame
			var release_event: InputEventKey = InputEventKey.new()
			release_event.keycode = keycode as Key
			release_event.physical_keycode = keycode as Key
			release_event.pressed = false
			Input.parse_input_event(release_event)

		_send_response({"success": true, "key": key, "pressed": pressed})
		return

	_send_response({"error": "Must provide 'key' or 'action' parameter"})


# --- Mouse Move ---
func _cmd_mouse_move(params: Dictionary) -> void:
	var x: float = float(params.get("x", 0))
	var y: float = float(params.get("y", 0))
	var relative_x: float = float(params.get("relative_x", 0))
	var relative_y: float = float(params.get("relative_y", 0))

	var event: InputEventMouseMotion = InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	event.relative = Vector2(relative_x, relative_y)
	Input.parse_input_event(event)

	_send_response({"success": true, "position": {"x": x, "y": y}})


# --- Get UI Elements ---
func _cmd_get_ui_elements() -> void:
	var elements: Array = []
	_collect_ui_elements(get_tree().root, elements)
	_send_response({"success": true, "elements": elements})


func _collect_ui_elements(node: Node, elements: Array) -> void:
	if node is Control:
		var ctrl: Control = node as Control
		if ctrl.visible and ctrl.get_global_rect().size.x > 0:
			var info: Dictionary = {
				"name": ctrl.name,
				"type": ctrl.get_class(),
				"path": str(ctrl.get_path()),
				"position": {"x": ctrl.global_position.x, "y": ctrl.global_position.y},
				"size": {"width": ctrl.size.x, "height": ctrl.size.y},
			}
			# Get text content for common text-bearing nodes
			if ctrl is Label:
				info["text"] = (ctrl as Label).text
			elif ctrl is Button:
				info["text"] = (ctrl as Button).text
			elif ctrl is LineEdit:
				info["text"] = (ctrl as LineEdit).text
			elif ctrl is RichTextLabel:
				info["text"] = (ctrl as RichTextLabel).get_parsed_text()

			elements.append(info)

	for child in node.get_children():
		_collect_ui_elements(child, elements)


# --- Get Scene Tree ---
func _cmd_get_scene_tree() -> void:
	var tree: Dictionary = _build_tree_node(get_tree().root)
	_send_response({"success": true, "tree": tree})


func _build_tree_node(node: Node) -> Dictionary:
	var info: Dictionary = {
		"name": node.name,
		"type": node.get_class(),
	}
	var children_arr: Array = []
	for child in node.get_children():
		children_arr.append(_build_tree_node(child))
	if children_arr.size() > 0:
		info["children"] = children_arr
	return info


# --- Key String to Keycode ---
func _string_to_keycode(key_str: String) -> int:
	var upper: String = key_str.to_upper()
	var key_map: Dictionary = {
		# Letters
		"A": KEY_A, "B": KEY_B, "C": KEY_C, "D": KEY_D,
		"E": KEY_E, "F": KEY_F, "G": KEY_G, "H": KEY_H,
		"I": KEY_I, "J": KEY_J, "K": KEY_K, "L": KEY_L,
		"M": KEY_M, "N": KEY_N, "O": KEY_O, "P": KEY_P,
		"Q": KEY_Q, "R": KEY_R, "S": KEY_S, "T": KEY_T,
		"U": KEY_U, "V": KEY_V, "W": KEY_W, "X": KEY_X,
		"Y": KEY_Y, "Z": KEY_Z,
		# Numbers
		"0": KEY_0, "1": KEY_1, "2": KEY_2, "3": KEY_3,
		"4": KEY_4, "5": KEY_5, "6": KEY_6, "7": KEY_7,
		"8": KEY_8, "9": KEY_9,
		# Special keys
		"SPACE": KEY_SPACE, "ENTER": KEY_ENTER, "RETURN": KEY_ENTER,
		"ESCAPE": KEY_ESCAPE, "ESC": KEY_ESCAPE,
		"TAB": KEY_TAB, "BACKSPACE": KEY_BACKSPACE,
		"DELETE": KEY_DELETE, "INSERT": KEY_INSERT,
		"HOME": KEY_HOME, "END": KEY_END,
		"PAGEUP": KEY_PAGEUP, "PAGE_UP": KEY_PAGEUP,
		"PAGEDOWN": KEY_PAGEDOWN, "PAGE_DOWN": KEY_PAGEDOWN,
		"UP": KEY_UP, "DOWN": KEY_DOWN, "LEFT": KEY_LEFT, "RIGHT": KEY_RIGHT,
		"SHIFT": KEY_SHIFT, "CTRL": KEY_CTRL, "CONTROL": KEY_CTRL,
		"ALT": KEY_ALT, "CAPSLOCK": KEY_CAPSLOCK, "CAPS_LOCK": KEY_CAPSLOCK,
		# Function keys
		"F1": KEY_F1, "F2": KEY_F2, "F3": KEY_F3, "F4": KEY_F4,
		"F5": KEY_F5, "F6": KEY_F6, "F7": KEY_F7, "F8": KEY_F8,
		"F9": KEY_F9, "F10": KEY_F10, "F11": KEY_F11, "F12": KEY_F12,
	}
	if key_map.has(upper):
		return key_map[upper]
	# Try single character keycode
	if key_str.length() == 1:
		return key_str.unicode_at(0)
	return KEY_NONE


# --- Eval: Execute arbitrary GDScript at runtime ---
func _cmd_eval(params: Dictionary) -> void:
	var code: String = params.get("code", "")
	if code.is_empty():
		_send_response({"error": "No code provided"})
		return

	# Wrap user code in a function so we can capture the return value
	var script_source: String = """extends Node

func execute():
	var __result = null
	__result = await _run()
	return __result

func _run():
%s
""" % [_indent_code(code)]

	var script: GDScript = GDScript.new()
	script.source_code = script_source
	var err: int = script.reload()
	if err != OK:
		_send_response({"error": "Failed to compile GDScript (error %d). Check syntax." % err})
		return

	var temp_node: Node = Node.new()
	temp_node.set_script(script)
	# Allow eval to work even when game is paused
	temp_node.process_mode = Node.PROCESS_MODE_ALWAYS
	add_child(temp_node)

	var result: Variant = null
	if temp_node.has_method("execute"):
		result = await temp_node.execute()

	temp_node.queue_free()
	_send_response({"success": true, "result": _variant_to_json(result)})


func _indent_code(code: String) -> String:
	var lines: PackedStringArray = code.split("\n")
	var indented: String = ""
	for line in lines:
		indented += "\t" + line + "\n"
	return indented


# --- Get Property ---
func _cmd_get_property(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var property: String = params.get("property", "")
	if node_path.is_empty() or property.is_empty():
		_send_response({"error": "node_path and property are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var value: Variant = node.get(property)
	_send_response({"success": true, "value": _variant_to_json(value), "property": property, "node_path": node_path})


# --- Set Property ---
func _cmd_set_property(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var property: String = params.get("property", "")
	if node_path.is_empty() or property.is_empty():
		_send_response({"error": "node_path and property are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var raw_value: Variant = params.get("value", null)
	var type_hint: String = params.get("type_hint", "")
	var value: Variant
	if type_hint.is_empty():
		value = _json_to_variant_for_property(node, property, raw_value)
	else:
		value = _json_to_variant(raw_value, type_hint)
	node.set(property, value)
	_send_response({"success": true, "node_path": node_path, "property": property, "value": _variant_to_json(node.get(property))})


# --- Call Method ---
func _cmd_call_method(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var method_name: String = params.get("method", "")
	if node_path.is_empty() or method_name.is_empty():
		_send_response({"error": "node_path and method are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node.has_method(method_name):
		_send_response({"error": "Method not found: %s on node %s" % [method_name, node_path]})
		return

	var args: Array = params.get("args", [])
	var result: Variant = node.callv(method_name, args)
	_send_response({"success": true, "result": _variant_to_json(result)})


# --- Get Node Info ---
func _cmd_get_node_info(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var properties: Array = []
	for prop in node.get_property_list():
		var prop_dict: Dictionary = prop
		if prop_dict.get("usage", 0) & PROPERTY_USAGE_EDITOR:
			properties.append({
				"name": prop_dict.get("name", ""),
				"type": prop_dict.get("type", 0),
				"value": _variant_to_json(node.get(prop_dict.get("name", "")))
			})

	var signals: Array = []
	for sig in node.get_signal_list():
		var sig_dict: Dictionary = sig
		signals.append(sig_dict.get("name", ""))

	var methods: Array = []
	for m in node.get_method_list():
		var m_dict: Dictionary = m
		if not str(m_dict.get("name", "")).begins_with("_"):
			methods.append(m_dict.get("name", ""))

	var children: Array = []
	for child in node.get_children():
		children.append({
			"name": child.name,
			"type": child.get_class(),
			"path": str(child.get_path())
		})

	_send_response({
		"success": true,
		"class": node.get_class(),
		"name": node.name,
		"path": str(node.get_path()),
		"properties": properties,
		"signals": signals,
		"methods": methods,
		"children": children
	})


# --- Instantiate Scene ---
func _cmd_instantiate_scene(params: Dictionary) -> void:
	var scene_path: String = params.get("scene_path", "")
	var parent_path: String = params.get("parent_path", "/root")
	if scene_path.is_empty():
		_send_response({"error": "scene_path is required"})
		return

	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		_send_response({"error": "Failed to load scene: %s" % scene_path})
		return

	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent node not found: %s" % parent_path})
		return

	var instance: Node = packed.instantiate()
	parent.add_child(instance)
	_send_response({"success": true, "instance_name": instance.name, "instance_path": str(instance.get_path())})


# --- Remove Node ---
func _cmd_remove_node(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var node_name: String = node.name
	node.queue_free()
	_send_response({"success": true, "removed": node_name})


# --- Change Scene ---
func _cmd_change_scene(params: Dictionary) -> void:
	var scene_path: String = params.get("scene_path", "")
	if scene_path.is_empty():
		_send_response({"error": "scene_path is required"})
		return

	var err: int = get_tree().change_scene_to_file(scene_path)
	if err != OK:
		_send_response({"error": "Failed to change scene. Error code: %d" % err})
		return

	_send_response({"success": true, "scene": scene_path})


# --- Pause ---
func _cmd_pause(params: Dictionary) -> void:
	var paused: bool = params.get("paused", true)
	get_tree().paused = paused
	_send_response({"success": true, "paused": paused})


# --- Get Performance ---
func _cmd_get_performance(_params: Dictionary) -> void:
	_send_response({
		"success": true,
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"frame_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_frame_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"memory_static": Performance.get_monitor(Performance.MEMORY_STATIC),
		"memory_static_max": Performance.get_monitor(Performance.MEMORY_STATIC_MAX),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"object_node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"object_orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"render_total_objects": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"render_total_draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	})


# --- Wait N Frames ---
func _cmd_wait(params: Dictionary) -> void:
	var frames: int = int(params.get("frames", 1))
	for i in frames:
		await get_tree().process_frame
	_send_response({"success": true, "waited_frames": frames})


# --- Helper: Convert Godot Variant to JSON-safe value ---
func _variant_to_json(value: Variant) -> Variant:
	if value == null:
		return null
	if value is bool or value is int or value is float or value is String:
		return value
	if value is Vector2:
		return {"x": value.x, "y": value.y}
	if value is Vector3:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Vector2i:
		return {"x": value.x, "y": value.y}
	if value is Vector3i:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Color:
		return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
	if value is Quaternion:
		return {"x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Basis:
		return {
			"x": _variant_to_json(value.x),
			"y": _variant_to_json(value.y),
			"z": _variant_to_json(value.z)
		}
	if value is Transform3D:
		return {
			"basis": _variant_to_json(value.basis),
			"origin": _variant_to_json(value.origin)
		}
	if value is Transform2D:
		return {
			"x": _variant_to_json(value.x),
			"y": _variant_to_json(value.y),
			"origin": _variant_to_json(value.origin)
		}
	if value is Rect2:
		return {"position": _variant_to_json(value.position), "size": _variant_to_json(value.size)}
	if value is AABB:
		return {"position": _variant_to_json(value.position), "size": _variant_to_json(value.size)}
	if value is NodePath:
		return str(value)
	if value is StringName:
		return str(value)
	# Packed arrays - serialize as JSON arrays instead of str() fallback
	if value is PackedByteArray:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedInt32Array or value is PackedInt64Array:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedFloat32Array or value is PackedFloat64Array:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedStringArray:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedVector2Array:
		var arr: Array = []
		for item in value:
			arr.append({"x": item.x, "y": item.y})
		return arr
	if value is PackedVector3Array:
		var arr: Array = []
		for item in value:
			arr.append({"x": item.x, "y": item.y, "z": item.z})
		return arr
	if value is PackedColorArray:
		var arr: Array = []
		for item in value:
			arr.append({"r": item.r, "g": item.g, "b": item.b, "a": item.a})
		return arr
	if value is Array:
		var arr: Array = []
		for item in value:
			arr.append(_variant_to_json(item))
		return arr
	if value is Dictionary:
		var dict: Dictionary = {}
		for key in value:
			dict[str(key)] = _variant_to_json(value[key])
		return dict
	if value is Object:
		if value is Node:
			return {"_type": "Node", "class": value.get_class(), "name": (value as Node).name, "path": str((value as Node).get_path())}
		if value is Resource:
			return {"_type": "Resource", "class": value.get_class(), "path": (value as Resource).resource_path}
		return {"_type": "Object", "class": value.get_class(), "id": value.get_instance_id()}
	# Fallback: convert to string
	return str(value)


# --- Helper: Convert JSON value back to Godot Variant ---
func _json_to_variant(value: Variant, type_hint: String = "") -> Variant:
	if value == null:
		return null
	if value is Dictionary:
		var dict: Dictionary = value
		# Explicit type hints take priority
		match type_hint:
			"Vector2":
				return Vector2(float(dict.get("x", 0)), float(dict.get("y", 0)))
			"Vector2i":
				return Vector2i(int(dict.get("x", 0)), int(dict.get("y", 0)))
			"Vector3":
				return Vector3(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)))
			"Vector3i":
				return Vector3i(int(dict.get("x", 0)), int(dict.get("y", 0)), int(dict.get("z", 0)))
			"Color":
				return Color(float(dict.get("r", 0)), float(dict.get("g", 0)), float(dict.get("b", 0)), float(dict.get("a", 1)))
			"Quaternion":
				return Quaternion(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)), float(dict.get("w", 1)))
			"Rect2":
				var pos: Dictionary = dict.get("position", {"x": 0, "y": 0})
				var sz: Dictionary = dict.get("size", {"x": 0, "y": 0})
				return Rect2(float(pos.get("x", 0)), float(pos.get("y", 0)), float(sz.get("x", 0)), float(sz.get("y", 0)))
			"AABB":
				var aabb_pos: Dictionary = dict.get("position", {"x": 0, "y": 0, "z": 0})
				var aabb_sz: Dictionary = dict.get("size", {"x": 0, "y": 0, "z": 0})
				return AABB(
					Vector3(float(aabb_pos.get("x", 0)), float(aabb_pos.get("y", 0)), float(aabb_pos.get("z", 0))),
					Vector3(float(aabb_sz.get("x", 0)), float(aabb_sz.get("y", 0)), float(aabb_sz.get("z", 0)))
				)
			"Basis":
				var bx: Dictionary = dict.get("x", {"x": 1, "y": 0, "z": 0})
				var by: Dictionary = dict.get("y", {"x": 0, "y": 1, "z": 0})
				var bz: Dictionary = dict.get("z", {"x": 0, "y": 0, "z": 1})
				return Basis(
					Vector3(float(bx.get("x", 0)), float(bx.get("y", 0)), float(bx.get("z", 0))),
					Vector3(float(by.get("x", 0)), float(by.get("y", 0)), float(by.get("z", 0))),
					Vector3(float(bz.get("x", 0)), float(bz.get("y", 0)), float(bz.get("z", 0)))
				)
			"Transform3D":
				var basis_dict: Dictionary = dict.get("basis", {})
				var origin_dict: Dictionary = dict.get("origin", {"x": 0, "y": 0, "z": 0})
				var basis: Basis = _json_to_variant(basis_dict, "Basis") if basis_dict.size() > 0 else Basis.IDENTITY
				var origin: Vector3 = Vector3(float(origin_dict.get("x", 0)), float(origin_dict.get("y", 0)), float(origin_dict.get("z", 0)))
				return Transform3D(basis, origin)
			"Transform2D":
				var tx: Dictionary = dict.get("x", {"x": 1, "y": 0})
				var ty: Dictionary = dict.get("y", {"x": 0, "y": 1})
				var t_origin: Dictionary = dict.get("origin", {"x": 0, "y": 0})
				return Transform2D(
					Vector2(float(tx.get("x", 0)), float(tx.get("y", 0))),
					Vector2(float(ty.get("x", 0)), float(ty.get("y", 0))),
					Vector2(float(t_origin.get("x", 0)), float(t_origin.get("y", 0)))
				)
		# Auto-detect from dict keys
		if dict.has("basis") and dict.has("origin"):
			return _json_to_variant(dict, "Transform3D")
		if dict.has("r") and dict.has("g") and dict.has("b"):
			return Color(float(dict.get("r", 0)), float(dict.get("g", 0)), float(dict.get("b", 0)), float(dict.get("a", 1)))
		if dict.has("x") and dict.has("y") and dict.has("z") and dict.has("w"):
			return Quaternion(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)), float(dict.get("w", 1)))
		if dict.has("position") and dict.has("size"):
			var pos_dict: Dictionary = dict["position"]
			var size_dict: Dictionary = dict["size"]
			if pos_dict.has("z") or size_dict.has("z"):
				return _json_to_variant(dict, "AABB")
			return _json_to_variant(dict, "Rect2")
		if dict.has("x") and dict.has("y") and dict.has("z"):
			return Vector3(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)))
		if dict.has("x") and dict.has("y") and dict.size() == 2:
			return Vector2(float(dict.get("x", 0)), float(dict.get("y", 0)))
		return value
	return value


# --- Helper: Convert JSON value using node's property type info ---
func _json_to_variant_for_property(node: Node, property: String, value: Variant) -> Variant:
	for prop in node.get_property_list():
		if prop["name"] == property:
			var type_id: int = prop.get("type", 0)
			match type_id:
				TYPE_VECTOR2:
					return _json_to_variant(value, "Vector2")
				TYPE_VECTOR2I:
					return _json_to_variant(value, "Vector2i")
				TYPE_VECTOR3:
					return _json_to_variant(value, "Vector3")
				TYPE_VECTOR3I:
					return _json_to_variant(value, "Vector3i")
				TYPE_COLOR:
					return _json_to_variant(value, "Color")
				TYPE_QUATERNION:
					return _json_to_variant(value, "Quaternion")
				TYPE_RECT2:
					return _json_to_variant(value, "Rect2")
				TYPE_AABB:
					return _json_to_variant(value, "AABB")
				TYPE_BASIS:
					return _json_to_variant(value, "Basis")
				TYPE_TRANSFORM3D:
					return _json_to_variant(value, "Transform3D")
				TYPE_TRANSFORM2D:
					return _json_to_variant(value, "Transform2D")
				TYPE_BOOL:
					if value is String:
						return value.to_lower() == "true"
					return bool(value)
				TYPE_INT:
					return int(value)
				TYPE_FLOAT:
					return float(value)
			break
	# No type info found, use raw value or auto-detect
	return _json_to_variant(value)


# --- Connect Signal ---
func _cmd_connect_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	var target_path: String = params.get("target_path", "")
	var method_name: String = params.get("method", "")
	if node_path.is_empty() or signal_name.is_empty() or target_path.is_empty() or method_name.is_empty():
		_send_response({"error": "node_path, signal_name, target_path, and method are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Source node not found: %s" % node_path})
		return

	var target: Node = get_tree().root.get_node_or_null(target_path)
	if target == null:
		_send_response({"error": "Target node not found: %s" % target_path})
		return

	if not node.has_signal(signal_name):
		_send_response({"error": "Signal '%s' not found on node %s" % [signal_name, node_path]})
		return

	if not target.has_method(method_name):
		_send_response({"error": "Method '%s' not found on target %s" % [method_name, target_path]})
		return

	if node.is_connected(signal_name, Callable(target, method_name)):
		_send_response({"error": "Signal already connected"})
		return

	node.connect(signal_name, Callable(target, method_name))
	_send_response({"success": true, "signal": signal_name, "from": node_path, "to": target_path, "method": method_name})


# --- Disconnect Signal ---
func _cmd_disconnect_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	var target_path: String = params.get("target_path", "")
	var method_name: String = params.get("method", "")
	if node_path.is_empty() or signal_name.is_empty() or target_path.is_empty() or method_name.is_empty():
		_send_response({"error": "node_path, signal_name, target_path, and method are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Source node not found: %s" % node_path})
		return

	var target: Node = get_tree().root.get_node_or_null(target_path)
	if target == null:
		_send_response({"error": "Target node not found: %s" % target_path})
		return

	var callable: Callable = Callable(target, method_name)
	if not node.is_connected(signal_name, callable):
		_send_response({"error": "Signal is not connected"})
		return

	node.disconnect(signal_name, callable)
	_send_response({"success": true, "disconnected": signal_name, "from": node_path, "to": target_path, "method": method_name})


# --- Emit Signal ---
func _cmd_emit_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	if node_path.is_empty() or signal_name.is_empty():
		_send_response({"error": "node_path and signal_name are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node.has_signal(signal_name):
		_send_response({"error": "Signal '%s' not found on node %s" % [signal_name, node_path]})
		return

	var args: Array = params.get("args", [])
	var call_args: Array = [signal_name]
	call_args.append_array(args)
	node.callv("emit_signal", call_args)
	_send_response({"success": true, "emitted": signal_name, "node": node_path, "arg_count": args.size()})


# --- Play Animation ---
func _cmd_play_animation(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node is AnimationPlayer:
		_send_response({"error": "Node is not an AnimationPlayer: %s (is %s)" % [node_path, node.get_class()]})
		return

	var anim_player: AnimationPlayer = node as AnimationPlayer
	var action: String = params.get("action", "play")

	match action:
		"play":
			var animation: String = params.get("animation", "")
			if animation.is_empty():
				_send_response({"error": "animation name is required for play action"})
				return
			if not anim_player.has_animation(animation):
				_send_response({"error": "Animation '%s' not found. Available: %s" % [animation, str(anim_player.get_animation_list())]})
				return
			anim_player.play(animation)
			_send_response({"success": true, "action": "play", "animation": animation})
		"stop":
			anim_player.stop()
			_send_response({"success": true, "action": "stop"})
		"pause":
			anim_player.pause()
			_send_response({"success": true, "action": "pause"})
		"get_list":
			var anims: Array = []
			for anim_name in anim_player.get_animation_list():
				anims.append(str(anim_name))
			_send_response({"success": true, "animations": anims, "current": anim_player.current_animation, "playing": anim_player.is_playing()})
		_:
			_send_response({"error": "Unknown animation action: %s. Use play, stop, pause, or get_list" % action})


# --- Tween Property ---
func _cmd_tween_property(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var property: String = params.get("property", "")
	if node_path.is_empty() or property.is_empty():
		_send_response({"error": "node_path and property are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var final_value: Variant = _json_to_variant_for_property(node, property, params.get("final_value", null))
	var duration: float = float(params.get("duration", 1.0))
	var trans_type: int = int(params.get("trans_type", 0))  # Tween.TRANS_LINEAR
	var ease_type: int = int(params.get("ease_type", 2))  # Tween.EASE_IN_OUT

	var tween: Tween = create_tween()
	tween.tween_property(node, property, final_value, duration).set_trans(trans_type).set_ease(ease_type)
	_send_response({"success": true, "node": node_path, "property": property, "duration": duration})


# --- Get Nodes In Group ---
func _cmd_get_nodes_in_group(params: Dictionary) -> void:
	var group_name: String = params.get("group", "")
	if group_name.is_empty():
		_send_response({"error": "group is required"})
		return

	var nodes: Array = get_tree().get_nodes_in_group(group_name)
	var result: Array = []
	for node in nodes:
		result.append({
			"name": node.name,
			"type": node.get_class(),
			"path": str(node.get_path())
		})
	_send_response({"success": true, "group": group_name, "count": result.size(), "nodes": result})


# --- Find Nodes By Class ---
func _cmd_find_nodes_by_class(params: Dictionary) -> void:
	var class_filter: String = params.get("class_name", "")
	if class_filter.is_empty():
		_send_response({"error": "class_name is required"})
		return

	var root_path: String = params.get("root_path", "/root")
	var root_node: Node = get_tree().root.get_node_or_null(root_path)
	if root_node == null:
		_send_response({"error": "Root node not found: %s" % root_path})
		return

	var found: Array = []
	_find_by_class_recursive(root_node, class_filter, found)
	_send_response({"success": true, "class_name": class_filter, "count": found.size(), "nodes": found})


func _find_by_class_recursive(node: Node, class_filter: String, results: Array) -> void:
	if node.get_class() == class_filter or node.is_class(class_filter):
		results.append({
			"name": node.name,
			"type": node.get_class(),
			"path": str(node.get_path())
		})
	for child in node.get_children():
		_find_by_class_recursive(child, class_filter, results)


# --- Reparent Node ---
func _cmd_reparent_node(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var new_parent_path: String = params.get("new_parent_path", "")
	if node_path.is_empty() or new_parent_path.is_empty():
		_send_response({"error": "node_path and new_parent_path are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var new_parent: Node = get_tree().root.get_node_or_null(new_parent_path)
	if new_parent == null:
		_send_response({"error": "New parent not found: %s" % new_parent_path})
		return

	var keep_global: bool = params.get("keep_global_transform", true)
	node.reparent(new_parent, keep_global)
	_send_response({"success": true, "node": node.name, "new_parent": new_parent_path, "new_path": str(node.get_path())})


func _exit_tree() -> void:
	if _client != null:
		_client.disconnect_from_host()
		_client = null
	if _server != null:
		_server.stop()
		_server = null
	print("McpInteractionServer: Stopped")
