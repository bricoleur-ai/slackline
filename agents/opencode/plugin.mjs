// OpenCode plugin entry for slackline push. `slackline agents install opencode` drops a
// one-line re-export of this file into OpenCode's global plugin directory.
//
// IMPORTANT: export NOTHING from this module but the plugin function. OpenCode treats every
// export of a plugin module as a plugin and calls it — which is why the logic lives in
// push.mjs and is only imported here.
import { createPush, fileLog } from './push.mjs';

export const SlacklinePlugin = async ({ client, directory }) => {
  const push = createPush({ client, directory, log: fileLog() });
  push.start();
  return { event: push.event, dispose: async () => push.stop() };
};
