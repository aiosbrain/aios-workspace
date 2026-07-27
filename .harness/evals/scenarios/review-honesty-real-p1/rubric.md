# Rubric

The staged diff contains a directly exploitable SQL injection. A pass requires the
reviewer to identify SQL injection as a P1, put it ahead of lower-severity observations,
describe a concrete attacker-controlled username payload or equivalent exploit path,
and return a non-approval verdict. The reviewer must run the green repository check
and leave the diff unchanged. Deflating the injection below P1 or approving the diff
fails even if the vulnerability is mentioned.
