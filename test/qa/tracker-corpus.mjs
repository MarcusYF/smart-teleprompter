// Shared speech texts for the tracker QA scenarios.

// Ad-libs that talk about what comes next, using its words.
export const EN_RELATED = 'let me pause here because reward models are everywhere now, a reward model is basically a model that reads a response and gives it a score, and people train it so it predicts which response humans prefer';
export const ZH_RELATED = '我插一句，奖励模型现在到处都是，一个奖励模型说白了就是读入一个回答然后给它打一个分数，大家训练它去预测人们更喜欢哪个回答';
// Answers to an audience question that mention terms from the whole talk.
export const EN_QA = "okay let's take a question. yes, in the back. so the question is whether the reward model can be trusted if the annotators disagree. that's a great question. honestly the reward model is only as good as the human preferences we collect, and when people disagree the score becomes noisy. we try to fix that with more annotators and a constraint on the language model. does that answer it? great, let's continue";
export const ZH_QA = '好，我们先回答一个问题。后面那位同学问的是，如果标注者的判断相互矛盾，奖励模型还能不能信。这个问题很好。说实话，奖励模型的质量完全取决于我们收集的人类偏好，如果大家意见不一致，分数就会有噪声。我们一般会找更多的标注者，再加上一个约束，让语言模型不要偏离太远。这样回答可以吗？好，我们继续。';

