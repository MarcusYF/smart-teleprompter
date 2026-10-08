# 过拟合与正则化

[slide 1: 什么是过拟合]
上节课我们训练了一个很大的 neural network，它在 training set 上的准确率接近百分之百。但是一到 validation set 上，准确率就掉到了百分之七十左右。这种现象就叫做 overfitting，也就是过拟合。

[slide 2: 为什么会过拟合]
过拟合的根本原因是模型的容量太大，而数据太少。模型没有学到真正的规律，而是把训练数据里的噪声也背了下来。

[slide 3: Weight decay]
第一种常用的方法是 weight decay，也叫 L2 正则化。我们在 loss function 里加上一项，惩罚过大的权重。这样模型会倾向于更简单、更平滑的解。

[slide 4: Dropout]
第二种方法是 dropout。训练的时候，我们随机地把一部分神经元的输出设成零，比如每次丢掉百分之五十。这样网络就不能依赖某几个特定的神经元，必须学到更稳健的特征。注意，在测试的时候要把 dropout 关掉。

[slide 5: Early stopping]
第三种方法最简单，叫 early stopping。我们一边训练一边看 validation loss，一旦它连续几个 epoch 不再下降，就停止训练。

最后提醒一下，这周的作业要求大家在 CIFAR-10 上比较这三种方法。截止时间是下周五晚上十二点。
