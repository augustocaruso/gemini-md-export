export class AhoCorasick {
    nodes = [{ next: new Map(), fail: 0, outputs: [] }];
    patterns = [];
    constructor(patterns) {
        for (const pattern of patterns) {
            if (!pattern.id || !pattern.pattern)
                continue;
            this.addPattern(pattern);
        }
        this.buildFailures();
    }
    search(text) {
        const matches = [];
        let state = 0;
        for (const char of String(text || '')) {
            while (state && !this.nodes[state].next.has(char)) {
                state = this.nodes[state].fail;
            }
            state = this.nodes[state].next.get(char) ?? 0;
            for (const output of this.nodes[state].outputs) {
                const pattern = this.patterns[output];
                matches.push({
                    id: pattern.id,
                    pattern: pattern.pattern,
                    value: pattern.value,
                });
            }
        }
        return matches;
    }
    addPattern(pattern) {
        const patternIndex = this.patterns.length;
        this.patterns.push(pattern);
        let state = 0;
        for (const char of pattern.pattern) {
            const existing = this.nodes[state].next.get(char);
            if (existing !== undefined) {
                state = existing;
                continue;
            }
            const nextIndex = this.nodes.length;
            this.nodes[state].next.set(char, nextIndex);
            this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
            state = nextIndex;
        }
        this.nodes[state].outputs.push(patternIndex);
    }
    buildFailures() {
        const queue = [];
        for (const child of this.nodes[0].next.values()) {
            this.nodes[child].fail = 0;
            queue.push(child);
        }
        while (queue.length) {
            const current = queue.shift();
            for (const [char, target] of this.nodes[current].next.entries()) {
                let fallback = this.nodes[current].fail;
                while (fallback && !this.nodes[fallback].next.has(char)) {
                    fallback = this.nodes[fallback].fail;
                }
                this.nodes[target].fail = this.nodes[fallback].next.get(char) ?? 0;
                this.nodes[target].outputs.push(...this.nodes[this.nodes[target].fail].outputs);
                queue.push(target);
            }
        }
    }
}
