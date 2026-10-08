# Attention in Transformers

[slide 1: Why attention]
Last week we saw that recurrent networks read a sentence one word at a time. That makes them slow to train, and they tend to forget words that appeared long ago.

[slide 2: Queries, keys and values]
Attention takes a different approach. Every word looks at every other word in the sentence and decides how much to care about it. To do this, each word is turned into three vectors: a query, a key, and a value. The query of one word is compared with the keys of all the others, and the result tells us how much weight each value gets.

[slide 3: Scaling]
There is one technical detail that matters in practice. We divide the scores by the square root of the key dimension before the softmax. Without this scaling, the softmax becomes very peaked, and the gradients almost vanish.

[slide 4: Multi-head attention]
In a real transformer we run eight or more attention heads in parallel. Each head can learn a different kind of relationship, for example one head tracks grammar while another tracks meaning. The outputs of all the heads are concatenated and projected back to the model dimension.

[slide 5: Cost]
The price we pay is memory. Because every word attends to every other word, the cost grows with the square of the sequence length. Doubling the context from four thousand to eight thousand tokens makes attention four times as expensive.

That is why so much recent research focuses on efficient attention. For the homework, please implement a single attention head from scratch in NumPy. We will build on it next Tuesday.
