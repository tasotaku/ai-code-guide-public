class TrainingConfig:
    def __init__(self):
        self.learning_rate = 3e-4
        self.batch_size = 32
        self.num_epochs = 100
        self.warmup_steps = 500
        self.weight_decay = 0.01
        self.gradient_clip = 1.0
        self.dropout = 0.1
        self.hidden_dim = 768
