# Measuring the app in a browser

These scripts time a production web build of the app on a phone-sized page with the processor slowed, against a throwaway local server with 2,000 messages in one channel. The numbers in [docs/performance.md](../../docs/performance.md) were made with them. They need Node 22 and Playwright with Chromium (`npm i -D playwright` anywhere on the module path).

```sh
W=~/servant-perf && mkdir -p $W                                  # a working folder outside the repository

# 1. A throwaway server.
(cd server && SERVANT_DATA_DIR=$W/data SERVANT_PORT=8788 node server.mjs &)

# 2. A production web build of the commit to measure, served with the single-page fallback.
(cd app && npx expo export -p web --output-dir $W/build)
node scripts/perf/serve.cjs $W/build 8099 &

# 3. Two people signed in. Make an invite for each (`node server.mjs invite --name "Pat Tester" --role owner`,
#    then one for Jo Park as a member), open http://localhost:8099/pair?<the invite's query> in Playwright,
#    join, and save each browser's storage as $W/state.json and $W/state-jo.json (context.storageState).

# 4. 2,000 messages in #general, marked read.
node scripts/perf/seed.cjs $W/data/messages.db

# 5. Measure: a label, how many runs, where to write the results.
PERF_DIR=$W node scripts/perf/measure.cjs main 5 $W/main.json
```

To compare two commits, build each into its own folder, serve them one after the other on the same port (the saved sign-ins belong to the address), and alternate single runs so that drift in the machine falls on both.

## What a run does

With the processor slowed four times (`THROTTLE=1` for no slowing):

1. **Open** the 2,000-message channel from Home: the time until its newest message is shown, and the script time until the page is quiet.
2. **Type** sixty characters in the reply field: script time, and the time from each key to the next painted frame.
3. **Incoming**: a second person sends fifteen messages while the channel is open: script time on the first person's page.
4. **Scroll** back through the history for twelve seconds (240 wheel steps of 400 points): how far it got, frame times, long tasks, script time.
5. **Reach**: keep scrolling until a message about 1,270 back is on screen: how long that takes.

"Script time" is the browser's own count of time spent running script (`ScriptDuration` from the DevTools protocol). A long task is one that holds the page for more than 50 ms.

## What it cannot tell you

Nothing about a phone. The iPhone and Android apps draw with native views and run script on a different engine, so these numbers do not carry over, and nothing here measures a gesture or an animation.
