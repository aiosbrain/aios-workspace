// Fixture for test/terminal-autobuild.test.mjs: drive createPresenter against a
// throwaway checkout (AIOS_TEST_TERMINAL_ROOT) exactly as a CLI command would.
import { createPresenter } from "../../scripts/ui.mjs";

const ui = await createPresenter({ root: process.env.AIOS_TEST_TERMINAL_ROOT });
if (ui) ui.message("Autobuild fixture rendered", "success");
else process.stdout.write("Autobuild fixture plain\n");
