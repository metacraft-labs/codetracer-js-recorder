// A deferred script answered after the document is parsed: the browser
// dispatches input between parsing and DOMContentLoaded while it waits.
note("defer:" + (Date.now() % 5));
