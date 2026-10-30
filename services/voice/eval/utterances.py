"""The STT evaluation set: things people say to a coding agent on a call.

`|` marks a hesitation: the clip gets a pause there (0.35-0.9 s, varied per clip), the way people
pause mid-sentence. Pauses over the VAD's 0.2 s stop are what split a turn into separately
transcribed segments in the old pipeline. Names come from VOCABULARY (agent names, project
jargon), which the models that support it get as hotwords.
"""

VOCABULARY = [
    "Jeff",
    "Ben",
    "Karl",
    "Nova",
    "Vibe Center",
    "Pipecat",
    "Parakeet",
    "Kokoro",
    "Tailscale",
    "Biome",
]

UTTERANCES: list[tuple[str, str]] = [
    ("pr_auth", "Open a PR for the auth refactor."),
    ("rebase", "Ask Ben to rebase onto main."),
    ("weather", "Can you check the weather | for this weekend in Hamburg?"),
    ("ci_42", "Check the CI status on PR forty two."),
    ("tests_fail", "The tests are failing on the login page, | can you take a look?"),
    ("merge_it", "Yes, merge it."),
    ("hey_jeff", "Hey Jeff, how are you doing?"),
    ("tools", "What tools can you use?"),
    ("deploy", "Deploy the staging branch | and tell me when it's done."),
    ("revert", "Revert the last commit, | it broke the build."),
    ("lint", "Run the linter and fix whatever Biome complains about."),
    ("line_numbers", "There's a bug on line one hundred and twelve of the server file."),
    ("nova_review", "Tell Nova to review | the pull request from Karl."),
    ("branch_name", "Create a branch called fix slash voice latency."),
    ("summary", "Give me a short summary of what changed today."),
    ("tailscale", "Is Tailscale still running on the dev machine?"),
    ("timeout", "Increase the timeout | to thirty seconds."),
    ("vibe_center", "Open the Vibe Center repo | and show me the open issues."),
    ("stop", "Sorry, stop. | Just say goodbye."),
    ("dependency", "Bump the Pipecat dependency to the latest version."),
    ("docker", "Why is the docker image | two gigabytes?"),
    ("env_var", "Set the environment variable API key in the settings page."),
    ("parakeet", "Switch the speech model | from Parakeet to Whisper."),
    ("kokoro_voice", "Use the Kokoro voice for the new agent."),
    ("migration", "Write a migration that adds a column for the user's email."),
    ("cancel", "Never mind, | cancel that."),
    ("percent", "What's the test coverage? Is it above eighty percent?"),
    ("logs", "Show me the last fifty lines | of the worker log."),
    ("schedule", "Remind me at three thirty | to check the deploy."),
    ("explain", "Explain what the bridge does | in two sentences."),
    ("typescript", "Convert this file to TypeScript | and keep the tests passing."),
    ("port", "The server should listen on port seven eight eight zero."),
    ("ok_go", "Okay, go ahead."),
    ("question", "Did the build on main pass | after Ben's change?"),
    ("search", "Search the docs for how to configure the GPU."),
    ("hamburg", "Book a meeting room in Hamburg | for Tuesday at ten."),
]
