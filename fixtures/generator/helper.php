<?php
// Included file -> exercises include/require pseudo-functions.

function helperWork(int $n): string
{
    $out = '';
    for ($i = 0; $i < $n; $i++) {
        $out .= str_pad((string) $i, 4, '0', STR_PAD_LEFT);
    }
    return $out;
}

class Widget
{
    private array $rows = [];

    public function __construct(private string $name)
    {
    }

    public function add(int $value): self
    {
        $this->rows[] = $value * 2;
        return $this;
    }

    public function total(): int
    {
        return array_sum($this->rows);
    }

    public static function make(string $name): self
    {
        return new self($name);
    }
}
