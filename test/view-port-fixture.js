/** Coordinate tests that must bind the same physical loopback port [N26,C7]. */
import { takeResource } from '../src/resources.js';

/** Take the physical port in the real account's pool, then restore all other test-state isolation. */
export async function takeDefaultViewPort(root, options = {}) {
  const privateMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  delete process.env.PULLBOARD_MACHINE_HOME;
  try {
    return await takeResource({ ...options, name: 'view-port-4890', capacity: 1, scope: 'machine', root });
  } finally {
    if (privateMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = privateMachineHome;
  }
}
