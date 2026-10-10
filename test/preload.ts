// Tests run inside board and huddle runs too; their identity vars would leak into the code under test
// (and into fake claude children), so every test file starts without them.
for (const k of ["CKANBAN_TICKET", "CKANBAN_HUDDLE_AGENT", "CKANBAN_OUTPUT_DIR"]) delete process.env[k];
