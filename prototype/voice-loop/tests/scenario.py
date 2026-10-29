"""The scripted user side of the e2e call: utterances and the silence after each.

`gap` is the silence after the utterance (seconds) before the next one starts. The barge-in
utterance starts `gap` seconds after the long question ends, while the bot is still answering.
"""

LEAD_IN = 3.0  # silence before the first utterance (connection setup)
TAIL = 8.0

STEPS = [
    {"id": "hello", "text": "Hey, can you hear me okay?", "gap": 7.0},
    {"id": "status", "text": "What are my agents doing right now?", "gap": 11.0},
    {"id": "dispatch", "text": "Tell the frontend agent to fix the login bug.", "gap": 13.0},
    # starts while the agent is still thinking about the previous question -> session/cancel
    {"id": "think", "text": "Which agent is the slowest one?", "gap": 1.3},
    {"id": "think_barge", "text": "Actually, never mind. Is the backend one still busy?", "gap": 11.0},
    {
        "id": "long",
        "text": "Explain in detail how you would coordinate five agents working on one big refactor.",
        "gap": 4.5,
    },
    {"id": "barge_in", "text": "Sorry, stop. Just tell me which agent needs my input.", "gap": 9.0},
    # the test injects a proactive event right after this gap starts; the server waits for idle
    {"id": "after_event", "text": "Thanks, that's all for now.", "gap": 0.0, "event_before": 14.0},
]

EVENT_TEXT = "frontend agent finished: the login bug is fixed and all tests pass"
USER_VOICE = "am_michael"  # differs from the bot voice so transcripts aren't confused
