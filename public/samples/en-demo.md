# Learning from Human Feedback

[slide 1: Opening]
Good afternoon, everyone, and welcome. Today I want to talk about how large language models learn from human feedback.
// Pause. Make eye contact.

[slide 2: The key idea]
>> Key idea: turn human preferences into a training signal
The key idea is simple: we reward the answers people prefer, and we penalize the ones they reject. In this way, human judgment becomes a training signal that we can optimize.

But there is a catch. Human preferences are noisy, and different people often disagree with each other. [[pause]] If we treat that noise as the truth, the model may simply learn the personal habits of the annotators.

[slide 3: Reward models]
To deal with this, researchers usually train a reward model first. The reward model reads a prompt and a response, and it outputs a score that estimates how likely people are to prefer that response. Then we use reinforcement learning to push the language model toward responses with higher scores.

[slide 4: Risks and summary]
However, the reward model makes mistakes too. When the language model over-optimizes the score, it can discover loopholes in the reward model, a problem known as reward hacking. In practice, we add a constraint that keeps the new model close to the original one.

To sum up, human feedback makes models more aligned with what we want, but it depends on high-quality data and careful optimization. Thank you.
