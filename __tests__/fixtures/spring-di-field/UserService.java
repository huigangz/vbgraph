package app;

import org.springframework.beans.factory.annotation.Autowired;

public class UserService {
    @Autowired
    private Foo foo;

    public String hello() {
        return foo.greet();
    }
}
