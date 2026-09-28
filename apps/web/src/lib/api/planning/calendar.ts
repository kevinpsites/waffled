// Step 2 · Calendar — this step's API client, DELIBERATELY EMPTY. The step reads the week
// with `useEventsRange` and adds to it through the app's own `EventModal`, which already
// writes the local-first path; a client here would be a second way to talk to the calendar.
//
// `export {}` keeps this a module so ./index.ts's `export * from './calendar'` resolves.
export {}
