"""The scripted user side of the app e2e call (e2e/call.spec.ts): utterances and the silence
after each. `gap` is the silence after the utterance (seconds) before the next one starts.

Written for the fake ACP agent (packages/server/test/fake-agent.ts), whose behaviour follows
keywords: "weather" makes a tool call before any text (filler), "slow" streams for ~4 s (the next
utterance barges in), anything else is echoed. With a real agent the same audio still works;
the gaps are long enough for a ~2 s reply.
"""

LEAD_IN = 3.0  # silence before the first utterance (connection setup)
TAIL = 6.0

STEPS = [
    {"id": "hello", "text": "Hello there, can you hear me?", "gap": 7.0},
    {"id": "weather", "text": "Can you check the weather for me?", "gap": 8.0},
    # the reply streams slowly; the next utterance talks over it -> cancel
    {"id": "slow", "text": "Tell me a slow story about a dragon.", "gap": 2.5},
    {"id": "barge_in", "text": "Sorry, stop. Just say goodbye.", "gap": 7.0},
    # the test injects a proactive event right after this gap starts; it is spoken when quiet
    {"id": "after_event", "text": "Thanks, that's all for now.", "gap": 0.0, "event_before": 9.0},
]

EVENT_TEXT = "The build agent finished: all tests pass."
USER_VOICE = "am_michael"  # differs from the agent voice so transcripts aren't confused
