/** The pullboard mcp command, in its own module so an item adding another command never edits these lines. */
import {
  mcpHere,
} from '../cli.js';

/** Run `pullboard mcp` and return its exit code. */
export async function run(io, args) {
  return await mcpHere(io, args);
}
